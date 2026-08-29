import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { FORMAT_VERSION } from "../constants.js";
import { normalizeNotionId } from "../shared/ids.js";
import type { Counts, Manifest, VerificationResult } from "../shared/types.js";
import { stringifyCanonical } from "../snapshot/canonical-json.js";

interface ParsedFiles {
  byPath: Map<string, unknown>;
  paths: string[];
}

export async function verifySnapshot(
  snapshotPath: string,
): Promise<VerificationResult> {
  const root = resolve(snapshotPath);
  const errors: string[] = [];
  if (!(await isDirectory(root)))
    return invalid([`Snapshot path is not a directory: ${root}`]);

  const expectedDirectories = [
    "pages",
    "databases",
    "data-sources",
    "comments",
    "assets/sha256",
    "assets/metadata",
  ];
  for (const directory of expectedDirectories) {
    if (!(await isDirectory(join(root, directory))))
      errors.push(`Missing directory: ${directory}`);
  }
  for (const file of ["manifest.json", "roots.json", "users.json"]) {
    if (!(await isFile(join(root, file)))) errors.push(`Missing file: ${file}`);
  }

  const parsed = await parseAllJson(root, errors);
  const manifest = parsed.byPath.get("manifest.json");
  if (!isManifest(manifest)) {
    errors.push("manifest.json has an invalid shape");
    return invalid(errors);
  }
  if (
    manifest.format_version !== 1 &&
    manifest.format_version !== FORMAT_VERSION
  ) {
    errors.push(`Unsupported format_version: ${manifest.format_version}`);
  }

  const counts = countResources(parsed.paths, parsed.byPath, errors);
  for (const [name, actual] of Object.entries(counts) as Array<
    [keyof Counts, number]
  >) {
    if (manifest.counts[name] !== actual) {
      errors.push(
        `Manifest count mismatch for ${name}: expected ${manifest.counts[name]}, found ${actual}`,
      );
    }
  }

  verifyCanonicalResources(parsed.byPath, errors);
  verifyRequiredResourceFiles(parsed.byPath, errors);
  verifyUsers(parsed.byPath, errors);
  verifyBlocks(parsed.byPath, errors);
  verifyRoots(parsed.byPath, errors);
  verifyRows(parsed.byPath, errors);
  verifyDatabaseAssociations(parsed.byPath, errors);
  verifyCommentReferences(parsed.byPath, errors);
  await verifyAssets(root, parsed.byPath, errors);
  return { valid: errors.length === 0, errors, counts };
}

function verifyRequiredResourceFiles(
  files: Map<string, unknown>,
  errors: string[],
): void {
  for (const [path, value] of files) {
    const page = path.match(/^pages\/([^/]+)\/page\.json$/);
    if (page) {
      const pageDirectory = `pages/${page[1] ?? ""}`;
      for (const required of ["blocks.json", "comments.json"]) {
        if (!files.has(`${pageDirectory}/${required}`))
          errors.push(
            `Missing page resource file: ${pageDirectory}/${required}`,
          );
      }
      if (isRecord(value) && isRecord(value.properties)) {
        for (const property of Object.values(value.properties)) {
          if (!isRecord(property) || typeof property.id !== "string") {
            errors.push(`Malformed embedded page property: ${path}`);
            continue;
          }
          const propertyPath = `${pageDirectory}/properties/${encodeURIComponent(property.id)}.json`;
          if (!files.has(propertyPath))
            errors.push(`Missing complete page property: ${propertyPath}`);
        }
      }
    }
    const dataSource = path.match(/^data-sources\/([^/]+)\/data-source\.json$/);
    if (dataSource) {
      const rowsPath = `data-sources/${dataSource[1] ?? ""}/rows.json`;
      if (!files.has(rowsPath))
        errors.push(`Missing data-source rows file: ${rowsPath}`);
    }
  }
}

function verifyUsers(files: Map<string, unknown>, errors: string[]): void {
  const users = files.get("users.json");
  if (!isRecord(users) || !Array.isArray(users.users)) return;
  const seen = new Set<string>();
  for (const user of users.users) {
    if (
      !isRecord(user) ||
      user.object !== "user" ||
      typeof user.id !== "string"
    ) {
      errors.push("users.json contains a malformed user");
      continue;
    }
    const id = safeNormalize(user.id);
    if (!id) errors.push(`users.json contains an invalid user ID: ${user.id}`);
    else if (seen.has(id))
      errors.push(`users.json contains duplicate user ${id}`);
    else seen.add(id);
  }
}

function verifyBlocks(files: Map<string, unknown>, errors: string[]): void {
  const seen = new Map<string, string>();
  for (const [path, value] of files) {
    if (!/^pages\/[^/]+\/blocks\.json$/.test(path)) continue;
    if (!Array.isArray(value)) {
      errors.push(`Malformed block tree: ${path}`);
      continue;
    }
    const visit = (blocks: unknown[]): void => {
      for (const block of blocks) {
        if (
          !isRecord(block) ||
          block.object !== "block" ||
          typeof block.id !== "string" ||
          !Array.isArray(block.children)
        ) {
          errors.push(`Malformed block in tree: ${path}`);
          continue;
        }
        const id = safeNormalize(block.id);
        if (!id) errors.push(`Invalid block ID in ${path}`);
        else {
          const prior = seen.get(id);
          if (prior)
            errors.push(`Duplicate canonical block ${id}: ${prior}, ${path}`);
          seen.set(id, path);
          if (
            block.type === "child_page" &&
            !files.has(`pages/${id}/page.json`)
          )
            errors.push(`Broken child-page traversal reference ${id}: ${path}`);
          if (
            block.type === "child_database" &&
            !files.has(`databases/${id}/database.json`)
          )
            errors.push(
              `Broken child-database traversal reference ${id}: ${path}`,
            );
        }
        visit(block.children);
      }
    };
    visit(value);
  }
}

async function parseAllJson(
  root: string,
  errors: string[],
): Promise<ParsedFiles> {
  const paths: string[] = [];
  await walk(root, root, paths, errors);
  const jsonPaths = paths.filter((path) => path.endsWith(".json")).sort();
  const byPath = new Map<string, unknown>();
  await Promise.all(
    jsonPaths.map(async (path) => {
      try {
        const contents = await readFile(join(root, path), "utf8");
        const value = JSON.parse(contents) as unknown;
        byPath.set(path, value);
        if (contents !== stringifyCanonical(value))
          errors.push(`Non-canonical JSON serialization: ${path}`);
      } catch (error) {
        errors.push(
          `Invalid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }),
  );
  return { byPath, paths };
}

async function walk(
  root: string,
  directory: string,
  paths: string[],
  errors: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      errors.push(`Symbolic links are not allowed: ${path}`);
    } else if (details.isDirectory()) {
      await walk(root, absolute, paths, errors);
    } else if (details.isFile()) {
      paths.push(path);
    } else {
      errors.push(`Unsupported filesystem entry: ${path}`);
    }
  }
}

function countResources(
  paths: string[],
  parsed: Map<string, unknown>,
  errors: string[],
): Counts {
  const users = parsed.get("users.json");
  if (!isRecord(users) || !Array.isArray(users.users))
    errors.push("users.json has an invalid shape");
  return {
    pages: paths.filter((path) => /^pages\/[^/]+\/page\.json$/.test(path))
      .length,
    databases: paths.filter((path) =>
      /^databases\/[^/]+\/database\.json$/.test(path),
    ).length,
    data_sources: paths.filter((path) =>
      /^data-sources\/[^/]+\/data-source\.json$/.test(path),
    ).length,
    views: paths.filter((path) =>
      /^databases\/[^/]+\/views\/[^/]+\.json$/.test(path),
    ).length,
    comments: paths.filter((path) => /^comments\/[^/]+\.json$/.test(path))
      .length,
    users:
      isRecord(users) && Array.isArray(users.users) ? users.users.length : 0,
    assets: paths.filter((path) =>
      /^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path),
    ).length,
  };
}

function verifyCanonicalResources(
  files: Map<string, unknown>,
  errors: string[],
): void {
  const patterns = [
    { regex: /^pages\/([^/]+)\/page\.json$/, type: "page" },
    { regex: /^databases\/([^/]+)\/database\.json$/, type: "database" },
    {
      regex: /^data-sources\/([^/]+)\/data-source\.json$/,
      type: "data_source",
    },
    { regex: /^databases\/[^/]+\/views\/([^/]+)\.json$/, type: "view" },
    { regex: /^comments\/([^/]+)\.json$/, type: "comment" },
  ];
  const seen = new Map<string, string>();
  for (const [path, value] of files) {
    for (const pattern of patterns) {
      const match = path.match(pattern.regex);
      if (!match) continue;
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        value.object !== pattern.type
      ) {
        errors.push(`Malformed canonical ${pattern.type}: ${path}`);
        break;
      }
      try {
        const pathId = normalizeNotionId(match[1] ?? "");
        const objectId = normalizeNotionId(value.id);
        if (pathId !== objectId)
          errors.push(`Canonical ID does not match path: ${path}`);
        const prior = seen.get(`${pattern.type}:${objectId}`);
        if (prior && prior !== path)
          errors.push(
            `Duplicate canonical ${pattern.type} ${objectId}: ${prior}, ${path}`,
          );
        seen.set(`${pattern.type}:${objectId}`, path);
      } catch {
        errors.push(`Invalid canonical UUID: ${path}`);
      }
      break;
    }
  }
}

function verifyRoots(files: Map<string, unknown>, errors: string[]): void {
  const rootsFile = files.get("roots.json");
  if (!isRecord(rootsFile) || !Array.isArray(rootsFile.roots)) {
    errors.push("roots.json has an invalid shape");
    return;
  }
  const manifest = files.get("manifest.json");
  const skipped = verifySkippedIds(rootsFile, errors);
  if (
    isManifest(manifest) &&
    JSON.stringify(manifest.roots) !== JSON.stringify(rootsFile.roots)
  ) {
    errors.push("roots.json does not match manifest roots");
  }
  if (
    isManifest(manifest) &&
    JSON.stringify(manifest.skipped ?? []) !== JSON.stringify(skipped)
  ) {
    errors.push("roots.json skipped IDs do not match manifest");
  }
  verifySkippedResources(files, new Set(skipped), errors);
  const seenRoots = new Set<string>();
  for (const root of rootsFile.roots) {
    if (
      !isRecord(root) ||
      typeof root.id !== "string" ||
      typeof root.type !== "string"
    ) {
      errors.push("roots.json contains a malformed root");
      continue;
    }
    const id = safeNormalize(root.id);
    if (!id) {
      errors.push(`roots.json contains invalid root ID: ${root.id}`);
      continue;
    }
    if (seenRoots.has(id)) errors.push(`Duplicate configured root: ${id}`);
    seenRoots.add(id);
    if (skipped.includes(id))
      errors.push(`Notion ID is both a root and skipped: ${id}`);
    const path =
      root.type === "page"
        ? `pages/${id}/page.json`
        : root.type === "database"
          ? `databases/${id}/database.json`
          : root.type === "data_source"
            ? `data-sources/${id}/data-source.json`
            : undefined;
    if (!path)
      errors.push(`roots.json contains unsupported root type: ${root.type}`);
    else if (!files.has(path))
      errors.push(`Missing canonical resource for root ${id}`);
  }
}

function verifySkippedResources(
  files: Map<string, unknown>,
  skipped: ReadonlySet<string>,
  errors: string[],
): void {
  if (skipped.size === 0) return;
  for (const id of skipped) {
    for (const path of [
      `pages/${id}/page.json`,
      `databases/${id}/database.json`,
      `data-sources/${id}/data-source.json`,
      `comments/${id}.json`,
    ]) {
      if (files.has(path)) errors.push(`Skipped resource is present: ${path}`);
    }
    if (
      [...files.keys()].some((path) =>
        new RegExp(`^databases/[^/]+/views/${id}\\.json$`).test(path),
      )
    )
      errors.push(`Skipped view is present: ${id}`);
  }

  const visitBlocks = (blocks: unknown[], path: string): void => {
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const id =
        typeof block.id === "string" ? safeNormalize(block.id) : undefined;
      if (id && skipped.has(id))
        errors.push(`Skipped block is present ${id}: ${path}`);
      if (Array.isArray(block.children)) visitBlocks(block.children, path);
    }
  };
  for (const [path, value] of files) {
    if (/^pages\/[^/]+\/blocks\.json$/.test(path) && Array.isArray(value))
      visitBlocks(value, path);
  }
}

function verifySkippedIds(
  rootsFile: Record<string, unknown>,
  errors: string[],
): string[] {
  if (rootsFile.skipped === undefined) return [];
  if (!Array.isArray(rootsFile.skipped)) {
    errors.push("roots.json has malformed skipped IDs");
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of rootsFile.skipped) {
    const id = typeof value === "string" ? safeNormalize(value) : undefined;
    if (!id) {
      errors.push(`roots.json contains invalid skipped ID: ${String(value)}`);
      continue;
    }
    if (seen.has(id)) errors.push(`Duplicate skipped ID: ${id}`);
    seen.add(id);
    result.push(id);
  }
  if (JSON.stringify(result) !== JSON.stringify([...result].sort()))
    errors.push("roots.json skipped IDs are not sorted");
  return result;
}

function verifyRows(files: Map<string, unknown>, errors: string[]): void {
  for (const [path, value] of files) {
    if (!/^data-sources\/[^/]+\/rows\.json$/.test(path)) continue;
    if (!isRecord(value) || !Array.isArray(value.pages)) {
      errors.push(`Malformed row references: ${path}`);
      continue;
    }
    const seen = new Set<string>();
    for (const row of value.pages) {
      if (typeof row !== "string") {
        errors.push(`Non-string row reference: ${path}`);
        continue;
      }
      const id = safeNormalize(row);
      if (!id || !files.has(`pages/${id}/page.json`)) {
        errors.push(`Broken data-source row reference ${row}: ${path}`);
      }
      if (id && seen.has(id))
        errors.push(`Duplicate data-source row reference ${id}: ${path}`);
      if (id) seen.add(id);
    }
    if (
      value.data_sources !== undefined &&
      !Array.isArray(value.data_sources)
    ) {
      errors.push(`Malformed child data-source references: ${path}`);
      continue;
    }
    for (const child of Array.isArray(value.data_sources)
      ? value.data_sources
      : []) {
      const id = typeof child === "string" ? safeNormalize(child) : undefined;
      if (!id || !files.has(`data-sources/${id}/data-source.json`))
        errors.push(
          `Broken child data-source reference ${String(child)}: ${path}`,
        );
      if (id && seen.has(id))
        errors.push(`Duplicate data-source member reference ${id}: ${path}`);
      if (id) seen.add(id);
    }
  }
}

function verifyDatabaseAssociations(
  files: Map<string, unknown>,
  errors: string[],
): void {
  const explicitDataSourceRoots = dataSourceRootIds(files);
  for (const [path, value] of files) {
    const databaseMatch = path.match(/^databases\/([^/]+)\/database\.json$/);
    if (databaseMatch && isRecord(value) && Array.isArray(value.data_sources)) {
      for (const source of value.data_sources) {
        if (!isRecord(source) || typeof source.id !== "string") {
          errors.push(`Malformed database data-source reference: ${path}`);
          continue;
        }
        const id = safeNormalize(source.id);
        if (!id || !files.has(`data-sources/${id}/data-source.json`)) {
          errors.push(
            `Broken database data-source reference ${source.id}: ${path}`,
          );
        }
      }
    }
    const sourceMatch = path.match(
      /^data-sources\/([^/]+)\/data-source\.json$/,
    );
    if (
      sourceMatch &&
      isRecord(value) &&
      isRecord(value.parent) &&
      typeof value.parent.database_id === "string"
    ) {
      const sourceId = safeNormalize(sourceMatch[1] ?? "");
      const databaseId = safeNormalize(value.parent.database_id);
      if (
        (!databaseId || !files.has(`databases/${databaseId}/database.json`)) &&
        (!sourceId || !explicitDataSourceRoots.has(sourceId))
      ) {
        errors.push(`Broken data-source database association: ${path}`);
      }
    }
    const viewMatch = path.match(/^databases\/([^/]+)\/views\/[^/]+\.json$/);
    if (viewMatch && isRecord(value)) {
      if (
        isRecord(value.parent) &&
        typeof value.parent.database_id === "string"
      ) {
        const expected = safeNormalize(viewMatch[1] ?? "");
        const actual = safeNormalize(value.parent.database_id);
        if (!expected || actual !== expected)
          errors.push(`View parent does not match its canonical path: ${path}`);
      }
      if (typeof value.data_source_id === "string") {
        const dataSourceId = safeNormalize(value.data_source_id);
        if (
          !dataSourceId ||
          !files.has(`data-sources/${dataSourceId}/data-source.json`)
        )
          errors.push(`Broken view data-source association: ${path}`);
      }
    }
  }
}

function dataSourceRootIds(files: Map<string, unknown>): Set<string> {
  const result = new Set<string>();
  const roots = files.get("roots.json");
  if (!isRecord(roots) || !Array.isArray(roots.roots)) return result;
  for (const root of roots.roots) {
    if (
      isRecord(root) &&
      root.type === "data_source" &&
      typeof root.id === "string"
    ) {
      const id = safeNormalize(root.id);
      if (id) result.add(id);
    }
  }
  return result;
}

function verifyCommentReferences(
  files: Map<string, unknown>,
  errors: string[],
): void {
  const referenced = new Set<string>();
  for (const [path, value] of files) {
    if (!/^pages\/[^/]+\/comments\.json$/.test(path)) continue;
    if (!isRecord(value) || !Array.isArray(value.comments)) {
      errors.push(`Malformed page comment references: ${path}`);
      continue;
    }
    for (const rawId of value.comments) {
      const id = typeof rawId === "string" ? safeNormalize(rawId) : undefined;
      if (!id || !files.has(`comments/${id}.json`))
        errors.push(`Broken comment reference ${String(rawId)}: ${path}`);
      else referenced.add(id);
    }
  }
  for (const path of files.keys()) {
    const match = path.match(/^comments\/([^/]+)\.json$/);
    if (match && !referenced.has(match[1] ?? ""))
      errors.push(`Orphan comment resource: ${path}`);
  }
}

async function verifyAssets(
  root: string,
  files: Map<string, unknown>,
  errors: string[],
): Promise<void> {
  const referenced = new Set<string>();
  for (const [path, value] of files) {
    if (path.startsWith("assets/metadata/")) continue;
    scanAssetReferences(value, path, referenced, errors);
  }
  for (const hash of referenced) {
    const expectedPath = `assets/sha256/${hash.slice(0, 2)}/${hash}`;
    const absolute = join(root, expectedPath);
    if (!(await isFile(absolute))) {
      errors.push(`Missing asset: ${expectedPath}`);
      continue;
    }
    const details = await stat(absolute);
    if ((await sha256(absolute)) !== hash)
      errors.push(`Asset hash mismatch: ${expectedPath}`);
    const metadataPath = `assets/metadata/${hash.slice(0, 2)}/${hash}.json`;
    const metadata = files.get(metadataPath);
    if (!metadata) {
      errors.push(`Missing asset metadata: ${hash}`);
    } else if (
      !isRecord(metadata) ||
      metadata.sha256 !== hash ||
      metadata.size !== details.size ||
      !Array.isArray(metadata.content_types) ||
      !Array.isArray(metadata.filenames)
    ) {
      errors.push(`Invalid asset metadata: ${metadataPath}`);
    }
  }
  const assetRoot = join(root, "assets", "sha256");
  if (await isDirectory(assetRoot)) {
    const paths: string[] = [];
    await walk(root, assetRoot, paths, errors);
    for (const path of paths.filter((entry) =>
      /^assets\/sha256\//.test(entry),
    )) {
      const hash = basename(path);
      if (!/^[a-f0-9]{64}$/.test(hash))
        errors.push(`Invalid content-addressed asset path: ${path}`);
      else if (!referenced.has(hash)) errors.push(`Orphan asset: ${path}`);
    }
  }
  for (const path of files.keys()) {
    const match = path.match(
      /^assets\/metadata\/[a-f0-9]{2}\/([a-f0-9]{64})\.json$/,
    );
    if (match && !referenced.has(match[1] ?? ""))
      errors.push(`Orphan asset metadata: ${path}`);
  }
}

function scanAssetReferences(
  value: unknown,
  sourcePath: string,
  referenced: Set<string>,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    for (const child of value)
      scanAssetReferences(child, sourcePath, referenced, errors);
    return;
  }
  if (!isRecord(value)) return;
  if (isRecord(value.backup_asset)) {
    const asset = value.backup_asset;
    if (
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      errors.push(`Malformed asset reference: ${sourcePath}`);
    } else {
      const expected = `assets/sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`;
      if (asset.path !== expected)
        errors.push(`Incorrect asset path in reference: ${sourcePath}`);
      referenced.add(asset.sha256);
    }
  }
  for (const child of Object.values(value))
    scanAssetReferences(child, sourcePath, referenced, errors);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isManifest(value: unknown): value is Manifest {
  if (
    !isRecord(value) ||
    typeof value.format_version !== "number" ||
    typeof value.exporter_version !== "string" ||
    typeof value.notion_api_version !== "string" ||
    !Array.isArray(value.roots) ||
    !isRecord(value.counts)
  ) {
    return false;
  }
  if (
    (value.format_version === 1 && typeof value.exported_at !== "string") ||
    (value.format_version !== 1 && value.exported_at !== undefined)
  ) {
    return false;
  }
  if (
    value.skipped !== undefined &&
    (!Array.isArray(value.skipped) ||
      !value.skipped.every((id) => typeof id === "string"))
  )
    return false;
  const counts = value.counts;
  return [
    "pages",
    "databases",
    "data_sources",
    "views",
    "comments",
    "users",
    "assets",
  ].every(
    (key) =>
      typeof counts[key] === "number" &&
      Number.isInteger(counts[key]) &&
      counts[key] >= 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNormalize(value: string): string | undefined {
  try {
    return normalizeNotionId(value);
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function invalid(errors: string[]): VerificationResult {
  return { valid: false, errors };
}
