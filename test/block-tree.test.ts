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
});
