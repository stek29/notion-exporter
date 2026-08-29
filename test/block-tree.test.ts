import { describe, expect, it } from "vitest";
import { retrieveBlockTree } from "../src/exporter/block-tree.js";
import { IDS, MockNotionApi } from "./helpers/mock-api.js";

describe("recursive blocks", () => {
  it("uses one consistent children array and preserves order", async () => {
    const api = new MockNotionApi();
    api.blocks.set(IDS.page1, [
      { object: "block", id: IDS.page2, type: "paragraph", has_children: true },
      {
        object: "block",
        id: IDS.database,
        type: "paragraph",
        has_children: false,
      },
    ]);
    api.blocks.set(IDS.page2, [
      {
        object: "block",
        id: IDS.view,
        type: "child_page",
        has_children: false,
      },
    ]);
    const result = await retrieveBlockTree(api, IDS.page1);
    expect(result.blocks.map((block) => block.id)).toEqual([
      IDS.page2,
      IDS.database,
    ]);
    expect(result.blocks[0]?.children[0]?.id).toBe(IDS.view);
    expect(result.blocks[1]?.children).toEqual([]);
    expect(result.childPages).toEqual([IDS.view]);
  });

  it("stops recursion at child page and database ownership boundaries", async () => {
    const api = new MockNotionApi();
    api.blocks.set(IDS.page1, [
      {
        object: "block",
        id: IDS.page2,
        type: "child_page",
        has_children: true,
      },
      {
        object: "block",
        id: IDS.database,
        type: "child_database",
        has_children: true,
      },
    ]);
    api.blocks.set(IDS.page2, [
      {
        object: "block",
        id: IDS.view,
        type: "paragraph",
        has_children: false,
      },
    ]);
    api.blocks.set(IDS.database, [
      {
        object: "block",
        id: IDS.dataSource,
        type: "paragraph",
        has_children: false,
      },
    ]);

    const result = await retrieveBlockTree(api, IDS.page1);

    expect(result.blocks[0]?.children).toEqual([]);
    expect(result.blocks[1]?.children).toEqual([]);
    expect(result.childPages).toEqual([IDS.page2]);
    expect(result.childDatabases).toEqual([IDS.database]);
    expect(result.blockIds).toEqual([IDS.page2, IDS.database]);
  });

  it("cuts a skipped block and its entire subtree", async () => {
    const api = new MockNotionApi();
    api.blocks.set(IDS.page1, [
      {
        object: "block",
        id: IDS.page2,
        type: "child_page",
        has_children: true,
      },
      {
        object: "block",
        id: IDS.view,
        type: "paragraph",
        has_children: false,
      },
    ]);
    api.blocks.set(IDS.page2, [
      {
        object: "block",
        id: IDS.database,
        type: "child_database",
        has_children: true,
      },
    ]);

    const result = await retrieveBlockTree(
      api,
      IDS.page1,
      undefined,
      (block) => block.id !== IDS.page2,
    );

    expect(result.blocks.map((block) => block.id)).toEqual([IDS.view]);
    expect(result.childPages).toEqual([]);
    expect(result.childDatabases).toEqual([]);
    expect(result.blockIds).toEqual([IDS.view]);
  });
});
