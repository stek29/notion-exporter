import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExportConfig } from "../src/config/export.js";

describe("export config loading", () => {
  it("loads roots and skips", async () => {
    const path = await configFile({
      roots: ["11111111-1111-1111-1111-111111111111"],
      skips: ["22222222-2222-2222-2222-222222222222"],
    });

    await expect(loadExportConfig(path)).resolves.toEqual({
      roots: ["11111111-1111-1111-1111-111111111111"],
      skips: ["22222222-2222-2222-2222-222222222222"],
    });
  });

  it("defaults omitted arrays to empty arrays", async () => {
    await expect(loadExportConfig(await configFile({}))).resolves.toEqual({
      roots: [],
      skips: [],
    });
  });

  it("rejects invalid JSON and non-string entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "notion-export-config-"));
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{");
    await expect(loadExportConfig(malformed)).rejects.toThrow("valid JSON");

    const wrongShape = await configFile({ roots: [123] });
    await expect(loadExportConfig(wrongShape)).rejects.toThrow(
      '"roots" must be an array of strings',
    );
  });
});

async function configFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "notion-export-config-"));
  const path = join(directory, "export.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}
