import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { exportSnapshot } from "../src/exporter/exporter.js";
import { verifySnapshot } from "../src/verify/verifier.js";
import { IDS, MockNotionApi, page, silentLogger } from "./helpers/mock-api.js";

describe("offline verifier", () => {
  it("detects count tampering and broken internal references", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-verify-"));
    const api = new MockNotionApi();
    api.pages.set(IDS.page1, page(IDS.page1));
    await exportSnapshot({
      roots: [IDS.page1],
      output,
      assetConcurrency: 1,
      api,
      logger: silentLogger(),
    });

    const manifestPath = join(output, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      counts: { pages: number };
    };
    manifest.counts.pages = 99;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await verifySnapshot(output);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "Manifest count mismatch for pages",
    );
  });

  it("detects tampering with a content-addressed asset", async () => {
    const output = await mkdtemp(join(tmpdir(), "notion-verify-asset-"));
    const api = new MockNotionApi();
    api.pages.set(IDS.page1, {
      ...page(IDS.page1),
      cover: {
        type: "file",
        file: {
          url: "data:text/plain;base64,aGVsbG8=",
          expiry_time: "volatile",
        },
      },
    });
    await exportSnapshot({
      roots: [IDS.page1],
      output,
      assetConcurrency: 1,
      api,
      logger: silentLogger(),
    });
    const exportedPage = JSON.parse(
      await readFile(join(output, "pages", IDS.page1, "page.json"), "utf8"),
    ) as { cover: { file: { backup_asset: { path: string } } } };
    await writeFile(
      join(output, exportedPage.cover.file.backup_asset.path),
      "HELLO",
    );
    const result = await verifySnapshot(output);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Asset hash mismatch");
  });
});
