import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { AssetManager } from "../assets/manager.js";
import {
  EXPORTER_VERSION,
  FORMAT_VERSION,
  NOTION_API_VERSION,
} from "../constants.js";
import type { NotionApi } from "../notion/api.js";
import { PreviousSnapshot } from "../incremental/previous-snapshot.js";
import { BackupError, VerificationError } from "../shared/errors.js";
import { normalizeNotionId } from "../shared/ids.js";
import type { Logger } from "../shared/logger.js";
import type {
  ExportStats,
  Manifest,
  NotionObject,
  RootRecord,
  RootType,
} from "../shared/types.js";
import {
  normalizeSnapshotDirectories,
  SnapshotWriter,
} from "../snapshot/writer.js";
import { stringifyCanonical } from "../snapshot/canonical-json.js";
import { verifySnapshot } from "../verify/verifier.js";
import { retrieveBlockTree } from "./block-tree.js";
import { needsIndividualPropertyRetrieval } from "./page-property.js";

export interface ExportOptions {
  roots: string[];
  skips?: string[];
  output: string;
  incrementalFrom?: string;
  comments?: CommentMode;
  assetConcurrency: number;
  api: NotionApi;
  logger: Logger;
  assetFetch?: typeof globalThis.fetch;
}

export type CommentMode = "none" | "all";

export async function exportSnapshot(
  options: ExportOptions,
): Promise<ExportStats> {
  const normalizedRoots = [
    ...new Set(options.roots.map(normalizeNotionId)),
  ].sort();
  const skipped = [
    ...new Set((options.skips ?? []).map(normalizeNotionId)),
  ].sort();
  if (normalizedRoots.length === 0)
    throw new BackupError("At least one export root is required");
  for (const root of normalizedRoots) {
    if (skipped.includes(root)) {
      throw new BackupError(
        `Notion ID is configured as both root and skip: ${root}`,
      );
    }
  }

  const output = resolve(options.output);
  const previous = options.incrementalFrom
    ? resolve(options.incrementalFrom)
    : undefined;
  if (previous) {
    requireSeparateSnapshotPaths(previous, output);
    const verification = await verifySnapshot(previous);
    if (!verification.valid) throw new VerificationError(verification.errors);
    options.logger.info("Previous snapshot verified", { path: previous });
  }
  await requireEmptyDirectory(output);
  await Promise.all(
    [
      "pages",
      "databases",
      "data-sources",
      "comments",
      "assets/sha256",
      "assets/metadata",
    ].map((directory) =>
      mkdir(resolve(output, directory), { recursive: true, mode: 0o755 }),
    ),
  );
  const writer = new SnapshotWriter(output);
  const assets = new AssetManager({
    writer,
    ...(previous ? { previous } : {}),
    concurrency: options.assetConcurrency,
    logger: options.logger,
    ...(options.assetFetch ? { fetch: options.assetFetch } : {}),
  });
  const reusePrevious = previous
    ? (await previousFormatMatches(previous)) &&
      (await previousSkipsMatch(previous, skipped))
    : false;
  if (previous && !reusePrevious) {
    options.logger.warn(
      "Previous format or skip configuration differs; resource reuse disabled for safety",
    );
  }
  const state = new ExportState(
    options.api,
    writer,
    assets,
    options.logger,
    options.comments ?? "none",
    new Set(skipped),
    previous && reusePrevious
      ? new PreviousSnapshot(previous, writer, assets)
      : undefined,
  );

  options.logger.info("Exporting configured roots", {
    roots: normalizedRoots.length,
    skipped: skipped.length,
  });
  for (const root of normalizedRoots) await state.exportRoot(root);
  await state.exportUsers();
  await state.waitForAll();
  await assets.finalize();

  const roots = [...state.roots].sort((a, b) => a.id.localeCompare(b.id));
  await writer.writeJson("roots.json", { roots, skipped });
  const stats = state.stats();
  assets.applyStats(stats);
  const manifest: Manifest = {
    format_version: FORMAT_VERSION,
    exporter_version: EXPORTER_VERSION,
    notion_api_version: NOTION_API_VERSION,
    roots,
    skipped,
    counts: {
      pages: stats.pages,
      databases: stats.databases,
      data_sources: stats.data_sources,
      views: stats.views,
      comments: stats.comments,
      users: stats.users,
      assets: stats.assets,
    },
  };
  await writer.writeJson("manifest.json", manifest);
  await normalizeSnapshotDirectories(output);

  const verification = await verifySnapshot(output);
  if (!verification.valid) throw new VerificationError(verification.errors);
  options.logger.info("Backup verified", formatStats(stats));
  return stats;
}

class ExportState {
  public readonly roots: RootRecord[] = [];
  private readonly pageTasks = new Map<string, Promise<void>>();
  private readonly databaseTasks = new Map<string, Promise<void>>();
  private readonly dataSourceTasks = new Map<string, Promise<void>>();
  private readonly viewTasks = new Map<string, Promise<void>>();
  private readonly comments = new Map<string, Promise<void>>();
  private readonly exportedViews = new Set<string>();
  private readonly referencedUsers = new Map<string, NotionObject[]>();
  private readonly prefetchedPages = new Map<string, NotionObject>();
  private readonly prefetchedDatabases = new Map<string, NotionObject>();
  private readonly prefetchedBlockChildren = new Map<string, NotionObject[]>();
  private readonly invalidPreviousEdges = new Set<string>();
  private userCount = 0;

  public constructor(
    private readonly api: NotionApi,
    private readonly writer: SnapshotWriter,
    private readonly assets: AssetManager,
    private readonly logger: Logger,
    private readonly commentMode: CommentMode,
    private readonly skipped: ReadonlySet<string>,
    private readonly previous: PreviousSnapshot | undefined,
  ) {}

  public async exportRoot(id: string): Promise<void> {
    const page = await this.tryRetrieve(() => this.api.retrievePage(id));
    if (page) {
      this.roots.push({ id, type: "page" });
      await this.exportPage(id, page);
      return;
    }
    const database = await this.tryRetrieve(() =>
      this.api.retrieveDatabase(id),
    );
    if (database) {
      this.roots.push({ id, type: "database" });
      await this.exportDatabase(id, database);
      return;
    }
    const dataSource = await this.tryRetrieve(() =>
      this.api.retrieveDataSource(id),
    );
    if (dataSource) {
      this.roots.push({ id, type: "data_source" });
      await this.exportDataSource(id, dataSource);
      return;
    }
    throw new BackupError(
      `Configured root is inaccessible or unsupported: ${id}`,
    );
  }

  public exportPage(id: string, prefetched?: NotionObject): Promise<void> {
    if (this.isSkipped(id)) return Promise.resolve();
    return this.memoize(this.pageTasks, id, async () => {
      const page =
        prefetched ??
        this.prefetchedPages.get(normalizeNotionId(id)) ??
        (await this.api.retrievePage(id));
      assertObject(page, id, "page");
      this.collectUsers(page);
      this.logger.debug("Exporting page", { id });

      const previousTraversal = await this.reusablePageTraversal(id, page);
      if (previousTraversal) {
        await this.previous?.reusePage(id, (value) => this.collectUsers(value));
        this.logger.debug("Reused unchanged page", { id });
        await Promise.all([
          ...previousTraversal.childPages.map((child) =>
            this.exportPage(child),
          ),
          ...previousTraversal.childDatabases.map((child) =>
            this.exportDatabase(child),
          ),
        ]);
        return;
      }

      const canonicalPageDone = this.assets.canonicalize(page, `page:${id}`);
      void canonicalPageDone.catch(() => undefined);

      const rawProperties = isRecord(page.properties)
        ? Object.values(page.properties)
        : [];
      const propertyTasks = rawProperties.map(async (property) => {
        if (!isRecord(property) || typeof property.id !== "string") {
          throw new BackupError(`Page ${id} contains a malformed property`);
        }
        const complete = needsIndividualPropertyRetrieval(property)
          ? await this.api.retrievePageProperty(id, property.id)
          : property;
        this.collectUsers(complete);
        const canonical = await this.assets.canonicalize(
          complete,
          `page:${id}:property:${property.id}`,
        );
        await this.writer.writeJson(
          `pages/${id}/properties/${encodeURIComponent(property.id)}.json`,
          canonical,
        );
      });
      const propertiesDone = Promise.all(propertyTasks);
      // Attach a handler immediately; comments and block discovery may still be running when a property fails.
      void propertiesDone.catch(() => undefined);

      const tree = await retrieveBlockTree(
        this.api,
        id,
        async (block) => {
          this.collectUsers(block);
          const canonical = await this.assets.canonicalize(
            block,
            `page:${id}:block:${block.id}`,
          );
          if (
            !isRecord(canonical) ||
            typeof canonical.id !== "string" ||
            typeof canonical.object !== "string"
          )
            throw new BackupError(
              `Canonicalization corrupted block ${block.id}`,
            );
          return canonical as NotionObject;
        },
        (block) =>
          !this.isSkipped(block.id) &&
          !this.invalidPreviousEdges.has(edgeKey(id, block.id)),
        this.prefetchedBlockChildren,
      );
      const commentIds = new Set<string>();
      const commentTasks: Promise<void>[] = [];
      const commentLists =
        this.commentMode === "all"
          ? await Promise.all(
              [id, ...tree.blockIds].map((anchor) =>
                this.api.listComments(anchor),
              ),
            )
          : [];
      for (const listed of commentLists) {
        for (const comment of listed) {
          if (this.isSkipped(comment.id)) continue;
          commentIds.add(comment.id);
          commentTasks.push(this.exportComment(comment));
        }
      }

      await Promise.all([propertiesDone, ...commentTasks]);
      const canonicalPage = await canonicalPageDone;
      await Promise.all([
        this.writer.writeJson(`pages/${id}/page.json`, canonicalPage),
        this.writer.writeJson(`pages/${id}/blocks.json`, tree.blocks),
        this.writer.writeJson(`pages/${id}/comments.json`, {
          comments: [...commentIds].sort(),
        }),
      ]);

      await Promise.all([
        ...tree.childPages.map((child) => this.exportPage(child)),
        ...tree.childDatabases.map((child) => this.exportDatabase(child)),
      ]);
    });
  }

  public exportDatabase(id: string, prefetched?: NotionObject): Promise<void> {
    if (this.isSkipped(id)) return Promise.resolve();
    return this.memoize(this.databaseTasks, id, async () => {
      const database =
        prefetched ??
        this.prefetchedDatabases.get(normalizeNotionId(id)) ??
        (await this.api.retrieveDatabase(id));
      assertObject(database, id, "database");
      this.logger.debug("Exporting database", { id });

      const rawDataSources = Array.isArray(database.data_sources)
        ? database.data_sources
        : [];
      const dataSources = rawDataSources.filter((source) => {
        if (!isRecord(source) || typeof source.id !== "string") {
          throw new BackupError(
            `Database ${id} contains a malformed data source reference`,
          );
        }
        return !this.isSkipped(source.id);
      });
      const retainedDatabase = Array.isArray(database.data_sources)
        ? { ...database, data_sources: dataSources }
        : database;
      const databasePath = `databases/${id}/database.json`;
      const previous = this.previous;
      if (
        previous &&
        (await previous.canReuse(databasePath, retainedDatabase))
      ) {
        await previous.reuseJson(databasePath, (value) =>
          this.collectUsers(value),
        );
        this.logger.debug("Reused unchanged database", { id });
      } else {
        this.collectUsers(retainedDatabase);
        const canonical = await this.assets.canonicalize(
          retainedDatabase,
          `database:${id}`,
        );
        await this.writer.writeJson(databasePath, canonical);
      }

      const views = await this.api.listViews(id);
      await Promise.all([
        ...dataSources.map((source) => {
          return this.exportDataSource(normalizeNotionId(source.id));
        }),
        ...views.map((view) => {
          if (typeof view.id !== "string")
            throw new BackupError(`Database ${id} has malformed view`);
          if (
            this.isSkipped(view.id) ||
            (typeof view.data_source_id === "string" &&
              this.isSkipped(view.data_source_id))
          )
            return Promise.resolve();
          return this.exportView(id, normalizeNotionId(view.id));
        }),
      ]);
    });
  }

  public exportDataSource(
    id: string,
    prefetched?: NotionObject,
  ): Promise<void> {
    if (this.isSkipped(id)) return Promise.resolve();
    return this.memoize(this.dataSourceTasks, id, async () => {
      const dataSource = prefetched ?? (await this.api.retrieveDataSource(id));
      assertObject(dataSource, id, "data_source");
      this.logger.debug("Exporting data source", { id });
      const dataSourcePath = `data-sources/${id}/data-source.json`;
      const reusable = await this.previous?.canReuse(
        dataSourcePath,
        dataSource,
      );
      const canonicalDone = reusable
        ? this.previous!.reuseJson(dataSourcePath, (value) =>
            this.collectUsers(value),
          )
        : this.assets
            .canonicalize(dataSource, `data-source:${id}`)
            .then(async (canonical) => {
              this.collectUsers(dataSource);
              await this.writer.writeJson(dataSourcePath, canonical);
            });
      void canonicalDone.catch(() => undefined);
      if (reusable) this.logger.debug("Reused unchanged data source", { id });
      const pageIds = new Set<string>();
      const childDataSourceIds = new Set<string>();
      const rowTasks: Promise<void>[] = [];
      for await (const row of this.api.iterateAllDataSourceRows(id)) {
        const rowId = normalizeNotionId(row.id);
        if (this.isSkipped(rowId)) continue;
        if (row.object === "page") {
          pageIds.add(rowId);
          rowTasks.push(this.exportPage(rowId, row));
        } else if (row.object === "data_source") {
          childDataSourceIds.add(rowId);
          rowTasks.push(this.exportDataSource(rowId, row));
        } else
          throw new BackupError(
            `Data source ${id} returned unsupported row type ${row.object}`,
          );
      }
      await Promise.all([
        canonicalDone,
        this.writer.writeJson(`data-sources/${id}/rows.json`, {
          pages: [...pageIds].sort(),
          data_sources: [...childDataSourceIds].sort(),
        }),
        ...rowTasks,
      ]);
    });
  }

  public async exportUsers(): Promise<void> {
    const users = await this.api.listUsers();
    const unique = new Map(
      users.map((user) => [normalizeNotionId(user.id), user]),
    );
    for (const [id, fragments] of this.referencedUsers) {
      if (unique.has(id)) continue;
      try {
        unique.set(id, await this.api.retrieveUser(id));
      } catch (error) {
        if (!this.api.isNotFound(error)) throw error;
        unique.set(id, selectBestUserFragment(fragments));
      }
    }
    const canonical = await this.assets.canonicalize(
      [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
      "users",
    );
    this.userCount = unique.size;
    await this.writer.writeJson("users.json", { users: canonical });
  }

  public async waitForAll(): Promise<void> {
    // Tasks can discover more tasks while resolving, so iterate until the graph is stable.
    let previous = -1;
    while (previous !== this.taskCount()) {
      previous = this.taskCount();
      await Promise.all([
        ...this.pageTasks.values(),
        ...this.databaseTasks.values(),
        ...this.dataSourceTasks.values(),
        ...this.viewTasks.values(),
        ...this.comments.values(),
      ]);
    }
  }

  public stats(): ExportStats {
    return {
      pages: this.pageTasks.size,
      databases: this.databaseTasks.size,
      data_sources: this.dataSourceTasks.size,
      views: this.exportedViews.size,
      comments: this.comments.size,
      users: this.userCount,
      assets: 0,
      assets_downloaded: 0,
      assets_reused_from_previous: 0,
      downloaded_bytes: 0,
    };
  }

  private exportView(databaseId: string, id: string): Promise<void> {
    if (this.isSkipped(id)) return Promise.resolve();
    return this.memoize(this.viewTasks, id, async () => {
      const view = await this.api.retrieveView(id);
      assertObject(view, id, "view");
      if (
        typeof view.data_source_id === "string" &&
        this.isSkipped(view.data_source_id)
      )
        return;
      const viewPath = `databases/${databaseId}/views/${id}.json`;
      const previous = this.previous;
      if (previous && (await previous.canReuse(viewPath, view))) {
        await previous.reuseJson(viewPath, (value) => this.collectUsers(value));
        this.logger.debug("Reused unchanged view", { id });
      } else {
        this.collectUsers(view);
        const canonical = await this.assets.canonicalize(view, `view:${id}`);
        await this.writer.writeJson(viewPath, canonical);
      }
      this.exportedViews.add(id);
    });
  }

  private exportComment(comment: NotionObject): Promise<void> {
    if (this.isSkipped(comment.id)) return Promise.resolve();
    return this.memoize(this.comments, comment.id, async () => {
      this.collectUsers(comment);
      const canonical = await this.assets.canonicalize(
        comment,
        `comment:${comment.id}`,
      );
      await this.writer.writeJson(
        `comments/${normalizeNotionId(comment.id)}.json`,
        canonical,
      );
    });
  }

  private async reusablePageTraversal(
    id: string,
    page: NotionObject,
  ): Promise<{ childPages: string[]; childDatabases: string[] } | undefined> {
    if (!this.previous || this.commentMode !== "none") return undefined;
    if (!(await this.previous.canReuse(`pages/${id}/page.json`, page)))
      return undefined;
    const [previousBlocks, currentBlocks] = await Promise.all([
      this.previous.pageBlocks(id),
      this.api.listBlockChildren(id),
    ]);
    this.prefetchedBlockChildren.set(normalizeNotionId(id), currentBlocks);
    if (!sameBlockListing(currentBlocks, previousBlocks)) return undefined;
    const traversal = await this.previous.pageTraversal(id);
    for (const child of traversal.childPages) {
      const current = await this.tryPreviousChild(() =>
        this.api.retrievePage(child),
      );
      if (!current || !isCurrentChildOf(current, id)) {
        this.invalidPreviousEdges.add(edgeKey(id, child));
        return undefined;
      }
      this.prefetchedPages.set(child, current);
    }
    for (const child of traversal.childDatabases) {
      const current = await this.tryPreviousChild(() =>
        this.api.retrieveDatabase(child),
      );
      if (!current || !isCurrentChildOf(current, id)) {
        this.invalidPreviousEdges.add(edgeKey(id, child));
        return undefined;
      }
      this.prefetchedDatabases.set(child, current);
    }
    return traversal;
  }

  private async tryPreviousChild(
    operation: () => Promise<NotionObject>,
  ): Promise<NotionObject | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (this.api.isLookupMiss(error)) return undefined;
      throw error;
    }
  }

  private memoize(
    map: Map<string, Promise<void>>,
    rawId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const id = normalizeNotionId(rawId);
    const existing = map.get(id);
    if (existing) return existing;
    const task = operation();
    map.set(id, task);
    return task;
  }

  private async tryRetrieve(
    operation: () => Promise<NotionObject>,
  ): Promise<NotionObject | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (this.api.isLookupMiss(error)) return undefined;
      throw error;
    }
  }

  private taskCount(): number {
    return (
      this.pageTasks.size +
      this.databaseTasks.size +
      this.dataSourceTasks.size +
      this.viewTasks.size +
      this.comments.size
    );
  }

  private isSkipped(id: string): boolean {
    return this.skipped.has(normalizeNotionId(id));
  }

  private collectUsers(value: unknown): void {
    collectUserFragments(value, this.referencedUsers);
  }
}

async function previousSkipsMatch(
  previous: string,
  skipped: string[],
): Promise<boolean> {
  const roots = JSON.parse(
    await readFile(resolve(previous, "roots.json"), "utf8"),
  ) as unknown;
  if (!isRecord(roots)) return false;
  const prior = Array.isArray(roots.skipped)
    ? roots.skipped.map((id) =>
        typeof id === "string" ? normalizeNotionId(id) : "",
      )
    : [];
  return JSON.stringify(prior.sort()) === JSON.stringify(skipped);
}

async function previousFormatMatches(previous: string): Promise<boolean> {
  const manifest = JSON.parse(
    await readFile(resolve(previous, "manifest.json"), "utf8"),
  ) as unknown;
  return isRecord(manifest) && manifest.format_version === FORMAT_VERSION;
}

function requireSeparateSnapshotPaths(previous: string, output: string): void {
  if (
    previous === output ||
    previous.startsWith(`${output}${sep}`) ||
    output.startsWith(`${previous}${sep}`)
  ) {
    throw new BackupError(
      "Previous snapshot and output directory must not overlap",
    );
  }
}

async function requireEmptyDirectory(path: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isDirectory())
      throw new BackupError(`Output is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      await mkdir(path, { recursive: true, mode: 0o755 });
    else throw error;
  }
  const entries = await readdir(path);
  if (entries.length > 0)
    throw new BackupError(`Output directory must be empty: ${path}`);
}

function assertObject(
  resource: NotionObject,
  expectedId: string,
  expectedType: RootType | "view",
): void {
  if (
    normalizeNotionId(resource.id) !== normalizeNotionId(expectedId) ||
    resource.object !== expectedType
  ) {
    throw new BackupError(
      `Notion returned a conflicting ${expectedType} resource for ${expectedId}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrentChildOf(resource: NotionObject, parentId: string): boolean {
  if (
    resource.in_trash === true ||
    resource.archived === true ||
    resource.is_archived === true ||
    !isRecord(resource.parent)
  ) {
    return false;
  }
  const expected = normalizeNotionId(parentId);
  for (const key of ["page_id", "block_id"]) {
    const value = resource.parent[key];
    if (typeof value === "string" && normalizeNotionId(value) === expected)
      return true;
  }
  return false;
}

function edgeKey(parentId: string, childId: string): string {
  return `${normalizeNotionId(parentId)}:${normalizeNotionId(childId)}`;
}

function sameBlockListing(
  current: NotionObject[],
  previous: unknown[],
): boolean {
  if (current.length !== previous.length) return false;
  return current.every((block, index) => {
    const prior = previous[index];
    if (
      !isRecord(prior) ||
      typeof prior.id !== "string" ||
      typeof block.last_edited_time !== "string" ||
      typeof prior.last_edited_time !== "string"
    ) {
      return false;
    }
    return (
      normalizeNotionId(block.id) === normalizeNotionId(prior.id) &&
      stringifyBlockRevision(block) === stringifyBlockRevision(prior)
    );
  });
}

function stringifyBlockRevision(block: Record<string, unknown>): string {
  return stringifyCanonical({
    object: block.object,
    type: block.type,
    last_edited_time: block.last_edited_time,
    has_children: block.has_children,
    parent: block.parent,
    in_trash: block.in_trash,
    archived: block.archived,
  });
}

function formatStats(stats: ExportStats): Record<string, number> {
  return {
    pages: stats.pages,
    databases: stats.databases,
    data_sources: stats.data_sources,
    views: stats.views,
    comments: stats.comments,
    users: stats.users,
    assets: stats.assets,
    assets_downloaded: stats.assets_downloaded,
    assets_reused_from_previous: stats.assets_reused_from_previous,
    downloaded_bytes: stats.downloaded_bytes,
  };
}

function collectUserFragments(
  value: unknown,
  users: Map<string, NotionObject[]>,
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectUserFragments(child, users);
    return;
  }
  if (!isRecord(value)) return;
  if (value.object === "user" && typeof value.id === "string") {
    const id = normalizeNotionId(value.id);
    const fragments = users.get(id) ?? [];
    fragments.push(value as NotionObject);
    users.set(id, fragments);
  }
  for (const child of Object.values(value)) collectUserFragments(child, users);
}

function selectBestUserFragment(fragments: NotionObject[]): NotionObject {
  const ordered = [...fragments].sort((a, b) => {
    const aText = JSON.stringify(a);
    const bText = JSON.stringify(b);
    return bText.length - aText.length || aText.localeCompare(bText);
  });
  const selected = ordered[0];
  if (!selected)
    throw new BackupError("Referenced user had no API representation");
  return selected;
}
