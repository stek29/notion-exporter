import { BackupError } from "../shared/errors.js";

export interface PaginatedResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
  request_status?: { type?: string; incomplete_reason?: string };
}

export async function collectPaginated<T>(
  request: (cursor?: string) => Promise<PaginatedResponse<T>>,
  label: string,
): Promise<T[]> {
  const results: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await request(cursor);
    if (!Array.isArray(response.results))
      throw new BackupError(`${label}: malformed results array`);
    if (response.request_status?.type === "incomplete") {
      throw new BackupError(
        `${label}: Notion returned incomplete results (${response.request_status.incomplete_reason ?? "unknown reason"})`,
      );
    }
    results.push(...response.results);
    if (!response.has_more) {
      if (response.next_cursor !== null) {
        throw new BackupError(
          `${label}: next_cursor was present when has_more was false`,
        );
      }
      return results;
    }
    if (!response.next_cursor)
      throw new BackupError(`${label}: has_more was true without next_cursor`);
    if (seenCursors.has(response.next_cursor)) {
      throw new BackupError(`${label}: pagination cursor repeated`);
    }
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  } while (cursor);
  return results;
}

export async function collectPageProperty(
  request: (cursor?: string) => Promise<Record<string, unknown>>,
  label: string,
): Promise<Record<string, unknown>> {
  const first = await request();
  if (first.object !== "list") return first;
  validatePropertyPage(first, label);

  const combined: Record<string, unknown> & { results: unknown[] } = {
    ...first,
    results: [...asArray(first.results)],
  };
  const seen = new Set<string>();
  let cursor = asCursor(first.next_cursor);
  while (cursor) {
    if (seen.has(cursor))
      throw new BackupError(`${label}: property cursor repeated`);
    seen.add(cursor);
    const next = await request(cursor);
    if (next.object !== "list")
      throw new BackupError(`${label}: pagination changed response shape`);
    validatePropertyPage(next, label);
    combined.results.push(...asArray(next.results));
    if (next.property_item !== undefined)
      combined.property_item = next.property_item;
    cursor = asCursor(next.next_cursor);
  }
  combined.has_more = false;
  combined.next_cursor = null;
  if (
    typeof combined.property_item === "object" &&
    combined.property_item !== null
  ) {
    combined.property_item = {
      ...(combined.property_item as object),
      next_url: null,
    };
  }
  return combined;
}

function validatePropertyPage(
  page: Record<string, unknown>,
  label: string,
): void {
  const cursor = asCursor(page.next_cursor);
  if (page.has_more === true && !cursor)
    throw new BackupError(`${label}: has_more was true without next_cursor`);
  if (page.has_more === false && cursor)
    throw new BackupError(
      `${label}: next_cursor was present when has_more was false`,
    );
  if (
    isRecord(page.request_status) &&
    page.request_status.type === "incomplete"
  )
    throw new BackupError(`${label}: Notion returned an incomplete property`);
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new BackupError("Malformed paginated property results");
  return value;
}

function asCursor(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new BackupError("Malformed paginated property cursor");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
