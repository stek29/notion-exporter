import {
  APIErrorCode,
  Client,
  isFullBlock,
  isFullComment,
  isFullDatabase,
  isFullDataSource,
  isFullPage,
  isFullView,
  isNotionClientError,
  iterateAllDataSourceRows,
} from "@notionhq/client";
import { NOTION_API_VERSION } from "../constants.js";
import { BackupError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { NotionObject } from "../shared/types.js";
import {
  collectPageProperty,
  collectPaginated,
  type PaginatedResponse,
} from "./pagination.js";
import { createRateLimitedFetch } from "./rate-limited-fetch.js";

export interface NotionApi {
  retrievePage(id: string): Promise<NotionObject>;
  retrieveDatabase(id: string): Promise<NotionObject>;
  retrieveDataSource(id: string): Promise<NotionObject>;
  retrievePageProperty(
    pageId: string,
    propertyId: string,
  ): Promise<Record<string, unknown>>;
  listBlockChildren(blockId: string): Promise<NotionObject[]>;
  listComments(blockId: string): Promise<NotionObject[]>;
  listUsers(): Promise<NotionObject[]>;
  retrieveUser(userId: string): Promise<NotionObject>;
  listViews(databaseId: string): Promise<NotionObject[]>;
  retrieveView(viewId: string): Promise<NotionObject>;
  iterateAllDataSourceRows(dataSourceId: string): AsyncIterable<NotionObject>;
  isNotFound(error: unknown): boolean;
}

export interface CreateNotionApiOptions {
  token: string;
  requestsPerSecond: number;
  concurrency: number;
  logger: Logger;
}

export function createNotionApi(options: CreateNotionApiOptions): NotionApi {
  const client = new Client({
    auth: options.token,
    notionVersion: NOTION_API_VERSION,
    fetch: createRateLimitedFetch({
      requestsPerSecond: options.requestsPerSecond,
      concurrency: options.concurrency,
      logger: options.logger,
    }),
    // This read-only client retries in the fetch wrapper so each attempt is globally rate limited.
    retry: false,
    logger: () => undefined,
  });

  return new SdkNotionApi(client);
}

class SdkNotionApi implements NotionApi {
  public constructor(private readonly client: Client) {}

  public async retrievePage(id: string): Promise<NotionObject> {
    return asFullNotionObject(
      await this.read(() => this.client.pages.retrieve({ page_id: id })),
      isFullPage,
      "page",
    );
  }

  public async retrieveDatabase(id: string): Promise<NotionObject> {
    return asFullNotionObject(
      await this.read(() =>
        this.client.databases.retrieve({ database_id: id }),
      ),
      isFullDatabase,
      "database",
    );
  }

  public async retrieveDataSource(id: string): Promise<NotionObject> {
    return asFullNotionObject(
      await this.read(() =>
        this.client.dataSources.retrieve({ data_source_id: id }),
      ),
      isFullDataSource,
      "data source",
    );
  }

  public async retrievePageProperty(
    pageId: string,
    propertyId: string,
  ): Promise<Record<string, unknown>> {
    return collectPageProperty(
      async (cursor) =>
        (await this.read(() =>
          this.client.pages.properties.retrieve({
            page_id: pageId,
            property_id: propertyId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        )) as unknown as Record<string, unknown>,
      `page ${pageId} property ${propertyId}`,
    );
  }

  public async listBlockChildren(blockId: string): Promise<NotionObject[]> {
    const blocks = await collectPaginated(
      async (cursor) =>
        (await this.read(() =>
          this.client.blocks.children.list({
            block_id: blockId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        )) as unknown as PaginatedResponse<NotionObject>,
      `block children ${blockId}`,
    );
    return blocks.map((block) =>
      asFullNotionObject(block, isFullBlock, "block"),
    );
  }

  public async listComments(blockId: string): Promise<NotionObject[]> {
    const comments = await collectPaginated(
      async (cursor) =>
        (await this.read(() =>
          this.client.comments.list({
            block_id: blockId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        )) as unknown as PaginatedResponse<NotionObject>,
      `comments ${blockId}`,
    );
    return comments.map((comment) =>
      asFullNotionObject(comment, isFullComment, "comment"),
    );
  }

  public async listUsers(): Promise<NotionObject[]> {
    return collectPaginated(
      async (cursor) =>
        (await this.read(() =>
          this.client.users.list({
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        )) as unknown as PaginatedResponse<NotionObject>,
      "users",
    );
  }

  public async retrieveUser(userId: string): Promise<NotionObject> {
    return asNotionObject(
      await this.read(() => this.client.users.retrieve({ user_id: userId })),
    );
  }

  public async listViews(databaseId: string): Promise<NotionObject[]> {
    return collectPaginated(
      async (cursor) =>
        (await this.read(() =>
          this.client.views.list({
            database_id: databaseId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        )) as unknown as PaginatedResponse<NotionObject>,
      `views ${databaseId}`,
    );
  }

  public async retrieveView(viewId: string): Promise<NotionObject> {
    return asFullNotionObject(
      await this.read(() => this.client.views.retrieve({ view_id: viewId })),
      isFullView,
      "view",
    );
  }

  public async *iterateAllDataSourceRows(
    dataSourceId: string,
  ): AsyncIterable<NotionObject> {
    // The SDK helper handles Notion's 10,000-result window by partitioning on created_time.
    // Deliberately omit in_trash: it is an optional filter, and a backup needs both states.
    for await (const row of iterateAllDataSourceRows(this.client, {
      data_source_id: dataSourceId,
    })) {
      yield asNotionObject(row);
    }
  }

  public isNotFound(error: unknown): boolean {
    return (
      isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound
    );
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

function asNotionObject(value: unknown): NotionObject {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    typeof (value as Record<string, unknown>).object !== "string"
  ) {
    throw new BackupError("Notion returned a malformed resource object");
  }
  return value as NotionObject;
}

function asFullNotionObject(
  value: unknown,
  predicate: (value: never) => boolean,
  resource: string,
): NotionObject {
  const object = asNotionObject(value);
  if (!predicate(object as never)) {
    throw new BackupError(`Notion returned a partial ${resource} object`);
  }
  return object;
}
