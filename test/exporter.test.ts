import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { exportSnapshot } from "../src/exporter/exporter.js";
import { verifySnapshot } from "../src/verify/verifier.js";
import { IDS, MockNotionApi, page, silentLogger } from "./helpers/mock-api.js";

describe("exporter", () => {
  it("resolves a database root after a page type mismatch and exports a deduplicated graph", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-backup-test-"));
    const api = fixtureApi();
    const stats = await exportSnapshot({
      roots: [IDS.database, IDS.database.replaceAll("-", "")],
      output,
      comments: "all",
      assetConcurrency: 2,
      api,
      logger: silentLogger(),
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });

    expect(stats).toMatchObject({
      pages: 2,
      databases: 1,
      data_sources: 2,
      views: 2,
      comments: 1,
    });
    // Repeated roots and repeated data-source rows still produce one canonical page.
    expect(stats.pages).toBe(2);
    expect(api.commentRetrievals.length).toBeGreaterThan(0);
    expect(api.pagePropertyRetrievals.sort()).toEqual(
      [`${IDS.page1}:rel`, `${IDS.page1}:rollup`].sort(),
    );
    expect(await verifySnapshot(output)).toMatchObject({ valid: true });

    const rows = JSON.parse(
      await readFile(
        join(output, "data-sources", IDS.dataSource, "rows.json"),
        "utf8",
      ),
    ) as { pages: string[]; data_sources: string[] };
    expect(rows.pages).toEqual([IDS.page1, IDS.page2]);
    expect(rows.data_sources).toEqual([]);
    const property = JSON.parse(
      await readFile(
        join(output, "pages", IDS.page1, "properties", "rel.json"),
        "utf8",
      ),
    ) as { results: unknown[] };
    expect(property.results).toHaveLength(2);
    await expect(
      readFile(
        join(output, "pages", IDS.page1, "properties", "formula.json"),
        "utf8",
      ),
    ).resolves.toContain('"formula"');
    await expect(
      readFile(
        join(output, "pages", IDS.page1, "properties", "rollup.json"),
        "utf8",
      ),
    ).resolves.toContain('"rollup"');
  });

  it("leaves partial output and no manifest after a required API failure", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-backup-failure-"));
    const api = fixtureApi();
    api.retrievePageProperty = async () => {
      throw new Error("mid-export failure");
    };
    await expect(
      exportSnapshot({
        roots: [IDS.page1],
        output,
        assetConcurrency: 1,
        api,
        logger: silentLogger(),
      }),
    ).rejects.toThrow("mid-export failure");
    await expect(readFile(join(output, "manifest.json"))).rejects.toThrow();
  });

  it("skips all comment API calls by default", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-no-comments-"));
    const api = fixtureApi();

    const stats = await exportSnapshot({
      roots: [IDS.page1],
      output,
      assetConcurrency: 1,
      api,
      logger: silentLogger(),
    });

    expect(api.commentRetrievals).toEqual([]);
    expect(stats.comments).toBe(0);
    expect(await verifySnapshot(output)).toMatchObject({ valid: true });
  });

  it("rejects a non-empty output directory", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-backup-nonempty-"));
    await writeFile(join(output, "keep"), "user data");
    await expect(
      exportSnapshot({
        roots: [IDS.page1],
        output,
        assetConcurrency: 1,
        api: fixtureApi(),
        logger: silentLogger(),
      }),
    ).rejects.toThrow("must be empty");
  });

  it("keeps a data-source root scoped to that data source and its descendants", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-data-source-root-"));
    const stats = await exportSnapshot({
      roots: [IDS.dataSource],
      output,
      assetConcurrency: 1,
      api: fixtureApi(),
      logger: silentLogger(),
    });

    expect(stats).toMatchObject({
      pages: 2,
      databases: 0,
      data_sources: 1,
      views: 0,
    });
    await expect(
      readFile(
        join(output, "data-sources", IDS.dataSource2, "data-source.json"),
      ),
    ).rejects.toThrow();
    expect(await verifySnapshot(output)).toMatchObject({ valid: true });
  });

  it("produces byte-identical deterministic files across unchanged exports", async () => {
    const first = await mkdtemp(join(tmpdir(), "notion-determinism-a-"));
    const second = await mkdtemp(join(tmpdir(), "notion-determinism-b-"));
    for (const output of [first, second]) {
      await exportSnapshot({
        roots: [IDS.database],
        output,
        assetConcurrency: 2,
        api: fixtureApi(),
        logger: silentLogger(),
      });
    }
    const firstFiles = await snapshotFiles(first);
    const secondFiles = await snapshotFiles(second);
    expect([...firstFiles.keys()]).toEqual([...secondFiles.keys()]);
    for (const [path, contents] of firstFiles) {
      if (path !== "manifest.json")
        expect(secondFiles.get(path)).toEqual(contents);
    }
  });
});

async function snapshotFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const entries = (await readdir(root, { recursive: true })) as string[];
  for (const path of entries.sort()) {
    if ((await stat(join(root, path))).isFile())
      files.set(path, await readFile(join(root, path)));
  }
  return files;
}

function fixtureApi(): MockNotionApi {
  const api = new MockNotionApi();
  api.databases.set(IDS.database, {
    object: "database",
    id: IDS.database,
    parent: { type: "workspace", workspace: true },
    data_sources: [
      { id: IDS.dataSource, name: "Tasks" },
      { id: IDS.dataSource2, name: "Projects" },
    ],
  });
  api.dataSources.set(IDS.dataSource, {
    object: "data_source",
    id: IDS.dataSource,
    parent: { type: "database_id", database_id: IDS.database },
    properties: {
      Relation: {
        id: "rel",
        type: "relation",
        relation: { data_source_id: IDS.dataSource2 },
      },
      Formula: {
        id: "formula",
        type: "formula",
        formula: { expression: "1 + 1" },
      },
      Rollup: { id: "rollup", type: "rollup", rollup: { function: "count" } },
    },
  });
  api.dataSources.set(IDS.dataSource2, {
    object: "data_source",
    id: IDS.dataSource2,
    parent: { type: "database_id", database_id: IDS.database },
    properties: {},
  });
  const relation = {
    id: "rel",
    type: "relation",
    relation: [{ id: IDS.page2 }],
    has_more: true,
  };
  api.pages.set(
    IDS.page1,
    page(IDS.page1, {
      Relation: relation,
      Formula: {
        id: "formula",
        type: "formula",
        formula: { type: "number", number: 2 },
      },
      Rollup: {
        id: "rollup",
        type: "rollup",
        rollup: { type: "number", number: 1 },
      },
    }),
  );
  api.pages.set(IDS.page2, {
    ...page(IDS.page2, {
      Relation: { ...relation, relation: [], has_more: false },
    }),
    in_trash: true,
    is_archived: true,
  });
  api.properties.set(`${IDS.page1}:rel`, {
    object: "list",
    results: [{ relation: { id: IDS.page2 } }, { relation: { id: IDS.page2 } }],
    has_more: false,
    next_cursor: null,
  });
  api.properties.set(`${IDS.page2}:rel`, {
    object: "list",
    results: [],
    has_more: false,
    next_cursor: null,
  });
  api.properties.set(`${IDS.page1}:formula`, {
    object: "property_item",
    id: "formula",
    type: "formula",
    formula: { type: "number", number: 2 },
  });
  api.properties.set(`${IDS.page1}:rollup`, {
    object: "property_item",
    id: "rollup",
    type: "rollup",
    rollup: { type: "number", number: 1, function: "count" },
  });
  api.rows.set(IDS.dataSource, [
    api.pages.get(IDS.page2)!,
    api.pages.get(IDS.page1)!,
    api.pages.get(IDS.page1)!,
  ]);
  api.rows.set(IDS.dataSource2, []);
  api.databaseViews.set(IDS.database, [
    { object: "view", id: IDS.view },
    { object: "view", id: IDS.view2 },
  ]);
  api.views.set(IDS.view, {
    object: "view",
    id: IDS.view,
    parent: { type: "database_id", database_id: IDS.database },
    type: "table",
  });
  api.views.set(IDS.view2, {
    object: "view",
    id: IDS.view2,
    parent: { type: "database_id", database_id: IDS.database },
    data_source_id: IDS.dataSource2,
    type: "board",
    filter: null,
    sorts: [],
    configuration: { board: { group_by: null } },
  });
  api.comments.set(IDS.page1, [
    {
      object: "comment",
      id: IDS.comment,
      parent: { type: "page_id", page_id: IDS.page1 },
      created_by: { object: "user", id: IDS.user },
      rich_text: [],
    },
  ]);
  api.users = [
    {
      object: "user",
      id: IDS.user,
      type: "person",
      name: "Ada",
      avatar_url: null,
    },
  ];
  return api;
}
