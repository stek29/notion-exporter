import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadNotionToken } from "../src/config/token.js";

describe("token loading", () => {
  it("reads and trims a secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "notion-token-"));
    const path = join(directory, "token");
    await writeFile(path, "ntn_secret\n", { mode: 0o600 });
    await expect(loadNotionToken({ NOTION_TOKEN_FILE: path })).resolves.toBe(
      "ntn_secret",
    );
  });

  it("rejects ambiguous secret sources", async () => {
    await expect(
      loadNotionToken({
        NOTION_TOKEN: "one",
        NOTION_TOKEN_FILE: "/somewhere",
      }),
    ).rejects.toThrow("only one");
  });
});
