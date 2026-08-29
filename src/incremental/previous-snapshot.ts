import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AssetManager } from "../assets/manager.js";
import { BackupError } from "../shared/errors.js";
import { normalizeNotionId } from "../shared/ids.js";
import type { NotionObject } from "../shared/types.js";
import { stringifyCanonical } from "../snapshot/canonical-json.js";
import type { SnapshotWriter } from "../snapshot/writer.js";

export interface PreviousPageTraversal {
  childPages: string[];
  childDatabases: string[];
}

interface CachedJson {
  text: string;
  value: unknown;
}

export class PreviousSnapshot {
  public readonly root: string;
  private readonly json = new Map<string, Promise<CachedJson | undefined>>();

  public constructor(
    root: string,
    private readonly writer: SnapshotWriter,
    private readonly assets: AssetManager,
  ) {
    this.root = resolve(root);
  }

  public async canReuse(
    relativePath: string,
    current: NotionObject,
  ): Promise<boolean> {
    const previous = (await this.readJson(relativePath))?.value;
    return isRecord(previous) && hasSameRevision(current, previous);
  }

  public async reusePage(
    id: string,
    observe: (value: unknown) => void,
  ): Promise<PreviousPageTraversal> {
    const directory = `pages/${id}`;
    const files = (await listFiles(this.path(directory)))
      .map((path) => relative(this.root, path).split(sep).join("/"))
      .filter((path) => path.endsWith(".json"))
      .filter((path) => path !== `${directory}/comments.json`)
      .sort();
    let blocks: unknown;
    await Promise.all(
      files.map(async (path) => {
        const value = await this.copyJson(path, observe);
        if (path === `${directory}/blocks.json`) blocks = value;
      }),
    );
    if (!Array.isArray(blocks))
      throw new BackupError(`Previous page has malformed blocks: ${id}`);
    await this.writer.writeJson(`${directory}/comments.json`, { comments: [] });
    return childResources(blocks);
  }

  public async pageTraversal(id: string): Promise<PreviousPageTraversal> {
    const blocks = await this.pageBlocks(id);
    return childResources(blocks);
  }

  public async pageBlocks(id: string): Promise<unknown[]> {
    const blocks = (await this.readJson(`pages/${id}/blocks.json`))?.value;
    if (!Array.isArray(blocks))
      throw new BackupError(`Previous page has malformed blocks: ${id}`);
    return blocks;
  }

  public async reuseJson(
    relativePath: string,
    observe: (value: unknown) => void,
  ): Promise<void> {
    await this.copyJson(relativePath, observe);
  }

  private async copyJson(
    relativePath: string,
    observe: (value: unknown) => void,
  ): Promise<unknown> {
    const cached = await this.readJson(relativePath);
    if (!cached)
      throw new BackupError(`Previous snapshot is missing ${relativePath}`);
    observe(cached.value);
    await Promise.all([
      this.assets.reuseCanonical(cached.value),
      this.writer.write(relativePath, cached.text),
    ]);
    return cached.value;
  }

  private readJson(relativePath: string): Promise<CachedJson | undefined> {
    let pending = this.json.get(relativePath);
    if (!pending) {
      pending = (async () => {
        try {
          const text = await readFile(this.path(relativePath), "utf8");
          return { text, value: JSON.parse(text) as unknown };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw new BackupError(
            `Could not read previous snapshot file: ${relativePath}`,
            { cause: error },
          );
        }
      })();
      this.json.set(relativePath, pending);
    }
    return pending;
  }

  private path(relativePath: string): string {
    const absolute = resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${sep}`))
      throw new BackupError(
        `Previous snapshot path escapes root: ${relativePath}`,
      );
    return absolute;
  }
}

function hasSameRevision(
  current: NotionObject,
  previous: Record<string, unknown>,
): boolean {
  if (
    typeof current.last_edited_time !== "string" ||
    typeof previous.last_edited_time !== "string" ||
    current.last_edited_time !== previous.last_edited_time ||
    current.object !== previous.object ||
    normalizeNotionId(current.id) !== normalizeNotionId(String(previous.id))
  ) {
    return false;
  }
  const structuralKeys = [
    "parent",
    "in_trash",
    "archived",
    "is_archived",
    ...(current.object === "database" ? ["data_sources"] : []),
    ...(current.object === "view" ? ["data_source_id"] : []),
  ];
  return structuralKeys.every(
    (key) =>
      stringifyCanonical({ value: current[key] }) ===
      stringifyCanonical({ value: previous[key] }),
  );
}

function childResources(blocks: unknown[]): PreviousPageTraversal {
  const childPages = new Set<string>();
  const childDatabases = new Set<string>();
  const visit = (children: unknown[]): void => {
    for (const child of children) {
      if (!isRecord(child) || typeof child.id !== "string")
        throw new BackupError("Previous snapshot contains a malformed block");
      if (child.object === "page" || child.type === "child_page")
        childPages.add(normalizeNotionId(child.id));
      if (child.object === "database" || child.type === "child_database")
        childDatabases.add(normalizeNotionId(child.id));
      if (Array.isArray(child.children)) visit(child.children);
    }
  };
  visit(blocks);
  return {
    childPages: [...childPages].sort(),
    childDatabases: [...childDatabases].sort(),
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
