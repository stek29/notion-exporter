import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DETERMINISTIC_MTIME } from "../constants.js";
import { BackupError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { Semaphore } from "../shared/semaphore.js";
import type { ExportStats, JsonObject, JsonValue } from "../shared/types.js";
import { SnapshotWriter } from "../snapshot/writer.js";

interface AssetIndexEntry {
  sha256: string;
  size: number;
  content_type?: string;
  filename?: string;
}

interface AssetRecord extends AssetIndexEntry {
  path: string;
}

interface AssetMetadata {
  sha256: string;
  size: number;
  content_types: Set<string>;
  filenames: Set<string>;
}

export interface AssetManagerOptions {
  writer: SnapshotWriter;
  previous?: string;
  concurrency: number;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
}

export class AssetManager {
  private readonly semaphore: Semaphore;
  private readonly fetch: typeof globalThis.fetch;
  private readonly byLocator = new Map<string, Promise<AssetRecord>>();
  private readonly metadata = new Map<string, AssetMetadata>();
  private readonly assetIndex = new Map<string, AssetIndexEntry>();
  private readonly importedAssets = new Map<string, Promise<void>>();
  private readonly reusedAssetHashes = new Set<string>();
  private indexLoaded = false;
  private downloaded = 0;
  private downloadedBytes = 0;

  public constructor(private readonly options: AssetManagerOptions) {
    this.semaphore = new Semaphore(options.concurrency);
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async canonicalize(
    value: unknown,
    source: string,
  ): Promise<JsonValue> {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((child, index) =>
          this.canonicalize(child, `${source}[${index}]`),
        ),
      );
    }

    if (typeof value !== "object")
      throw new BackupError(`Unsupported API value at ${source}`);

    const record = value as Record<string, unknown>;
    if (
      record.type === "file" &&
      isRecord(record.file) &&
      typeof record.file.url === "string"
    ) {
      const filename = inferFilename(record, record.file.url);
      const asset = await this.store(record.file.url, filename);
      const preserved = Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => key !== "file" && key !== "expiry_time",
        ),
      );
      return this.canonicalize(
        {
          ...preserved,
          type: "file",
          file: { backup_asset: asset },
        },
        source,
      );
    }

    if (
      record.type === "custom_emoji" &&
      isRecord(record.custom_emoji) &&
      typeof record.custom_emoji.url === "string"
    ) {
      const emoji = record.custom_emoji;
      const emojiUrl = record.custom_emoji.url;
      const asset = await this.store(emojiUrl, inferFilename(emoji, emojiUrl));
      return this.canonicalize(
        {
          ...record,
          custom_emoji: {
            ...Object.fromEntries(
              Object.entries(emoji).filter(([key]) => key !== "url"),
            ),
            backup_asset: asset,
          },
        },
        source,
      );
    }

    const entries = await Promise.all(
      Object.entries(record)
        .filter(([key, child]) => key !== "request_id" && child !== undefined)
        .map(async ([key, child]) => {
          if (key === "avatar_url" && typeof child === "string") {
            const asset = await this.store(child, inferFilename(record, child));
            return [key, { backup_asset: asset }] as const;
          }
          return [
            key,
            await this.canonicalize(child, `${source}.${key}`),
          ] as const;
        }),
    );
    return Object.fromEntries(entries) as JsonObject;
  }

  public async reuseCanonical(value: unknown): Promise<void> {
    if (!this.options.previous)
      throw new BackupError("Previous snapshot is required for asset reuse");
    await this.loadPreviousIndex();
    await this.scanPreviousAssets(value);
  }

  public async finalize(): Promise<void> {
    for (const [hash, metadata] of [...this.metadata].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      await this.options.writer.writeJson(
        `assets/metadata/${hash.slice(0, 2)}/${hash}.json`,
        {
          sha256: hash,
          size: metadata.size,
          content_types: [...metadata.content_types].sort(),
          filenames: [...metadata.filenames].sort(),
        },
      );
    }
    const index = Object.fromEntries(
      [...this.assetIndex]
        .filter(([, entry]) => this.metadata.has(entry.sha256))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    await this.options.writer.writeJson("assets/index.json", index);
    await rmdir(this.options.writer.path(".asset-tmp")).catch(() => undefined);
  }

  public applyStats(stats: ExportStats): void {
    stats.assets = this.metadata.size;
    stats.assets_downloaded = this.downloaded;
    stats.assets_reused_from_previous = this.reusedAssetHashes.size;
    stats.downloaded_bytes = this.downloadedBytes;
  }

  private async store(url: string, filename?: string): Promise<AssetRecord> {
    await this.loadPreviousIndex();
    const locator = stableLocatorKey(url);
    let pending = this.byLocator.get(locator);
    if (!pending) {
      pending = this.semaphore.run(() => this.obtain(url, locator, filename));
      this.byLocator.set(locator, pending);
    }
    const asset = await pending;
    const metadata = this.metadata.get(asset.sha256) ?? {
      sha256: asset.sha256,
      size: asset.size,
      content_types: new Set<string>(),
      filenames: new Set<string>(),
    };
    if (asset.content_type) metadata.content_types.add(asset.content_type);
    if (filename ?? asset.filename)
      metadata.filenames.add(filename ?? asset.filename ?? "");
    this.metadata.set(asset.sha256, metadata);
    return filename ? { ...asset, filename } : asset;
  }

  private async obtain(
    url: string,
    locator: string,
    filename?: string,
  ): Promise<AssetRecord> {
    const previous = this.assetIndex.get(locator);
    if (previous && this.options.previous) {
      const previousPath = join(
        this.options.previous,
        assetRelativePath(previous.sha256),
      );
      if (await validateHash(previousPath, previous.sha256, previous.size)) {
        const selectedFilename = filename ?? previous.filename;
        const record = await this.copyToSnapshot(previousPath, {
          ...previous,
          ...(selectedFilename ? { filename: selectedFilename } : {}),
        });
        this.reusedAssetHashes.add(previous.sha256);
        return record;
      }
      this.options.logger.warn("Ignoring unusable previous asset entry", {
        sha256: previous.sha256,
      });
      this.assetIndex.delete(locator);
    }

    const downloaded = await this.download(url, filename);
    const record = await this.moveIntoSnapshot(
      downloaded.temporary,
      downloaded,
    );
    this.downloaded += 1;
    this.downloadedBytes += downloaded.size;
    const indexEntry: AssetIndexEntry = {
      sha256: record.sha256,
      size: record.size,
      ...(record.content_type ? { content_type: record.content_type } : {}),
      ...(record.filename ? { filename: record.filename } : {}),
    };
    this.assetIndex.set(locator, indexEntry);
    return record;
  }

  private async download(
    url: string,
    filename?: string,
  ): Promise<AssetIndexEntry & { temporary: string }> {
    const temporaryDirectory = this.options.writer.path(".asset-tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const temporary = join(temporaryDirectory, randomUUID());
      try {
        const response = await this.fetch(url, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body) {
          throw new BackupError(
            `Asset server returned HTTP ${response.status}`,
          );
        }
        const hash = createHash("sha256");
        let size = 0;
        const hasher = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as never),
          hasher,
          createWriteStream(temporary, { mode: 0o600 }),
        );
        const expectedLength = response.headers.get("content-length");
        if (expectedLength && Number(expectedLength) !== size) {
          throw new BackupError(
            "Asset content length did not match response header",
          );
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim();
        return {
          temporary,
          sha256: hash.digest("hex"),
          size,
          ...(contentType ? { content_type: contentType } : {}),
          ...(filename ? { filename } : {}),
        };
      } catch (error) {
        lastError = error;
        await unlink(temporary).catch(() => undefined);
        if (attempt < 3) await delay(500 * 2 ** attempt);
      }
    }
    throw new BackupError(
      "Required Notion-hosted asset could not be downloaded",
      { cause: lastError },
    );
  }

  private async moveIntoSnapshot(
    temporary: string,
    entry: AssetIndexEntry,
  ): Promise<AssetRecord> {
    const relative = assetRelativePath(entry.sha256);
    const destination = this.options.writer.path(relative);
    await mkdir(dirname(destination), { recursive: true });
    if (await validateHash(destination, entry.sha256, entry.size)) {
      await unlink(temporary).catch(() => undefined);
    } else {
      await rename(temporary, destination);
    }
    await normalizeSnapshotAsset(destination);
    return { ...entry, path: relative };
  }

  private async copyToSnapshot(
    source: string,
    entry: AssetIndexEntry,
  ): Promise<AssetRecord> {
    const relative = assetRelativePath(entry.sha256);
    const destination = this.options.writer.path(relative);
    if (!(await validateHash(destination, entry.sha256, entry.size)))
      await copyEfficient(source, destination);
    await normalizeSnapshotAsset(destination);
    return { ...entry, path: relative };
  }

  private async loadPreviousIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    if (!this.options.previous) return;
    try {
      const parsed = JSON.parse(
        await readFile(
          join(this.options.previous, "assets/index.json"),
          "utf8",
        ),
      ) as unknown;
      if (!isRecord(parsed))
        throw new Error("previous asset index is not an object");
      for (const [locator, value] of Object.entries(parsed)) {
        if (
          isRecord(value) &&
          typeof value.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(value.sha256) &&
          typeof value.size === "number"
        ) {
          this.assetIndex.set(locator, value as unknown as AssetIndexEntry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn("Ignoring unreadable previous asset index");
      }
    }
  }

  private async scanPreviousAssets(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      await Promise.all(value.map((child) => this.scanPreviousAssets(child)));
      return;
    }
    if (!isRecord(value)) return;
    if (isRecord(value.backup_asset)) {
      const asset = value.backup_asset;
      if (
        typeof asset.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        asset.path !== assetRelativePath(asset.sha256)
      ) {
        throw new BackupError(
          "Previous snapshot has a malformed asset reference",
        );
      }
      let pending = this.importedAssets.get(asset.sha256);
      if (!pending) {
        pending = this.importPreviousAsset(asset.sha256);
        this.importedAssets.set(asset.sha256, pending);
      }
      await pending;
    }
    await Promise.all(
      Object.values(value).map((child) => this.scanPreviousAssets(child)),
    );
  }

  private async importPreviousAsset(hash: string): Promise<void> {
    if (!this.options.previous)
      throw new BackupError("Previous snapshot is required for asset reuse");
    const metadataPath = join(
      this.options.previous,
      `assets/metadata/${hash.slice(0, 2)}/${hash}.json`,
    );
    let metadataValue: unknown;
    try {
      metadataValue = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      throw new BackupError(
        `Could not read metadata for previous asset ${hash}`,
        {
          cause: error,
        },
      );
    }
    if (
      !isRecord(metadataValue) ||
      metadataValue.sha256 !== hash ||
      typeof metadataValue.size !== "number" ||
      !Array.isArray(metadataValue.content_types) ||
      !metadataValue.content_types.every(
        (value) => typeof value === "string",
      ) ||
      !Array.isArray(metadataValue.filenames) ||
      !metadataValue.filenames.every((value) => typeof value === "string")
    ) {
      throw new BackupError(`Previous asset metadata is malformed: ${hash}`);
    }
    const source = join(this.options.previous, assetRelativePath(hash));
    if (!(await validateHash(source, hash, metadataValue.size)))
      throw new BackupError(`Previous asset is missing or corrupt: ${hash}`);
    await this.copyToSnapshot(source, {
      sha256: hash,
      size: metadataValue.size,
    });
    const metadata = this.metadata.get(hash) ?? {
      sha256: hash,
      size: metadataValue.size,
      content_types: new Set<string>(),
      filenames: new Set<string>(),
    };
    for (const contentType of metadataValue.content_types)
      metadata.content_types.add(contentType as string);
    for (const filename of metadataValue.filenames)
      metadata.filenames.add(filename as string);
    this.metadata.set(hash, metadata);
    this.reusedAssetHashes.add(hash);
  }
}

function assetRelativePath(hash: string): string {
  return `assets/sha256/${hash.slice(0, 2)}/${hash}`;
}

async function validateHash(
  path: string,
  expectedHash: string,
  expectedSize: number,
): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size !== expectedSize) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path))
      hash.update(chunk as Buffer);
    return hash.digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

async function copyEfficient(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_FICLONE);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function normalizeSnapshotAsset(path: string): Promise<void> {
  await chmod(path, 0o644);
  await utimes(path, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
}

function stableLocatorKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return createHash("sha256")
      .update(`${url.origin}${url.pathname}`)
      .digest("hex");
  } catch {
    throw new BackupError("Notion returned a malformed hosted asset URL");
  }
}

function inferFilename(
  record: Record<string, unknown>,
  rawUrl: string,
): string | undefined {
  if (typeof record.name === "string" && record.name.trim()) return record.name;
  try {
    const name = decodeURIComponent(basename(new URL(rawUrl).pathname));
    return name && extname(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
