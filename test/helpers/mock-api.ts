import type { NotionApi } from "../../src/notion/api.js";
import type { NotionObject } from "../../src/shared/types.js";

export class NotFoundError extends Error {}
export class TypeMismatchError extends Error {}

export class MockNotionApi implements NotionApi {
  public readonly pages = new Map<string, NotionObject>();
  public readonly databases = new Map<string, NotionObject>();
  public readonly dataSources = new Map<string, NotionObject>();
  public readonly blocks = new Map<string, NotionObject[]>();
  public readonly comments = new Map<string, NotionObject[]>();
  public readonly properties = new Map<string, Record<string, unknown>>();
  public readonly views = new Map<string, NotionObject>();
  public readonly databaseViews = new Map<string, NotionObject[]>();
  public readonly rows = new Map<string, NotionObject[]>();
  public users: NotionObject[] = [];
  public pageRetrievals = new Map<string, number>();
  public pagePropertyRetrievals: string[] = [];
  public commentRetrievals: string[] = [];

  public async retrievePage(id: string): Promise<NotionObject> {
    this.pageRetrievals.set(id, (this.pageRetrievals.get(id) ?? 0) + 1);
    if (!this.pages.has(id) && this.databases.has(id))
      throw new TypeMismatchError(id);
    return required(this.pages, id);
  }

  public async retrieveDatabase(id: string): Promise<NotionObject> {
    return required(this.databases, id);
  }

  public async retrieveDataSource(id: string): Promise<NotionObject> {
    return required(this.dataSources, id);
  }

  public async retrievePageProperty(
    pageId: string,
    propertyId: string,
  ): Promise<Record<string, unknown>> {
    this.pagePropertyRetrievals.push(`${pageId}:${propertyId}`);
    const value = this.properties.get(`${pageId}:${propertyId}`);
    if (!value)
      throw new Error(`Missing property fixture ${pageId}:${propertyId}`);
    return value;
  }

  public async listBlockChildren(blockId: string): Promise<NotionObject[]> {
    return this.blocks.get(blockId) ?? [];
  }

  public async listComments(blockId: string): Promise<NotionObject[]> {
    this.commentRetrievals.push(blockId);
    return this.comments.get(blockId) ?? [];
  }

  public async listUsers(): Promise<NotionObject[]> {
    return this.users;
  }

  public async retrieveUser(userId: string): Promise<NotionObject> {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) throw new NotFoundError(userId);
    return structuredClone(user);
  }

  public async listViews(databaseId: string): Promise<NotionObject[]> {
    return this.databaseViews.get(databaseId) ?? [];
  }

  public async retrieveView(viewId: string): Promise<NotionObject> {
    return required(this.views, viewId);
  }

  public async *iterateAllDataSourceRows(
    dataSourceId: string,
  ): AsyncIterable<NotionObject> {
    for (const row of this.rows.get(dataSourceId) ?? []) yield row;
  }

  public isNotFound(error: unknown): boolean {
    return error instanceof NotFoundError;
  }

  public isLookupMiss(error: unknown): boolean {
    return error instanceof NotFoundError || error instanceof TypeMismatchError;
  }
}

function required(map: Map<string, NotionObject>, id: string): NotionObject {
  const value = map.get(id);
  if (!value) throw new NotFoundError(id);
  return structuredClone(value);
}

export const IDS = {
  page1: "11111111-1111-1111-1111-111111111111",
  page2: "22222222-2222-2222-2222-222222222222",
  database: "33333333-3333-3333-3333-333333333333",
  dataSource: "44444444-4444-4444-4444-444444444444",
  view: "55555555-5555-5555-5555-555555555555",
  comment: "66666666-6666-6666-6666-666666666666",
  user: "77777777-7777-7777-7777-777777777777",
  dataSource2: "88888888-8888-8888-8888-888888888888",
  view2: "99999999-9999-9999-9999-999999999999",
} as const;

export function page(
  id: string,
  properties: Record<string, unknown> = {},
): NotionObject {
  return {
    object: "page",
    id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    in_trash: false,
    parent: { type: "workspace", workspace: true },
    properties,
    url: `https://notion.so/${id.replaceAll("-", "")}`,
  };
}

export function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
