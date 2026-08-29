import { describe, expect, it } from "vitest";
import {
  collectPageProperty,
  collectPaginated,
} from "../src/notion/pagination.js";

describe("pagination", () => {
  it("collects every page in order", async () => {
    const cursors: Array<string | undefined> = [];
    const results = await collectPaginated(async (cursor) => {
      cursors.push(cursor);
      return cursor
        ? { results: [3], has_more: false, next_cursor: null }
        : { results: [1, 2], has_more: true, next_cursor: "next" };
    }, "fixture");
    expect(results).toEqual([1, 2, 3]);
    expect(cursors).toEqual([undefined, "next"]);
  });

  it("fails on repeated or incomplete pagination", async () => {
    await expect(
      collectPaginated(
        async () => ({ results: [], has_more: true, next_cursor: "same" }),
        "fixture",
      ),
    ).rejects.toThrow("cursor repeated");
    await expect(
      collectPaginated(
        async () => ({
          results: [],
          has_more: false,
          next_cursor: null,
          request_status: { type: "incomplete", incomplete_reason: "limit" },
        }),
        "fixture",
      ),
    ).rejects.toThrow("incomplete");
  });

  it("combines paginated page properties", async () => {
    const property = await collectPageProperty(
      async (cursor) =>
        cursor
          ? {
              object: "list",
              results: [{ relation: { id: "b" } }],
              next_cursor: null,
              has_more: false,
              property_item: { next_url: null, rollup: { number: 2 } },
            }
          : {
              object: "list",
              results: [{ relation: { id: "a" } }],
              next_cursor: "next",
              has_more: true,
              property_item: {
                next_url: "volatile",
                rollup: { number: 1 },
              },
            },
      "relation",
    );
    expect(property.results).toHaveLength(2);
    expect(property).toMatchObject({
      has_more: false,
      next_cursor: null,
      property_item: { next_url: null, rollup: { number: 2 } },
    });
  });
});
