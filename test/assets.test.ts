import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AssetManager } from "../src/assets/manager.js";
import { SnapshotWriter } from "../src/snapshot/writer.js";
import { silentLogger } from "./helpers/mock-api.js";

describe("assets", () => {
  it("hashes assets, deduplicates content, and reuses a previous snapshot", async () => {
    const firstOutput = await outputDirectory();
    const networkFetch = vi.fn(fetch);
    const first = new AssetManager({
      writer: new SnapshotWriter(firstOutput),
      concurrency: 2,
      logger: silentLogger(),
      fetch: networkFetch,
    });
    const input = {
      type: "file",
      name: "hello.txt",
      file: { url: "data:text/plain;base64,aGVsbG8=", expiry_time: "volatile" },
    };
    const canonical = (await first.canonicalize(
      [input, input],
      "fixture",
    )) as Array<{
      file: { backup_asset: { sha256: string; path: string } };
    }>;
    expect(canonical[0]?.file.backup_asset.sha256).toBe(
      canonical[1]?.file.backup_asset.sha256,
    );
    expect(networkFetch).toHaveBeenCalledTimes(1);

    const emoji = (await first.canonicalize(
      {
        type: "custom_emoji",
        custom_emoji: {
          id: "88888888-8888-8888-8888-888888888888",
          name: "hello",
          url: "data:text/plain;base64,aGVsbG8=",
        },
      },
      "emoji",
    )) as {
      custom_emoji: {
        url?: string;
        backup_asset: { sha256: string };
      };
    };
    expect(emoji.custom_emoji.url).toBeUndefined();
    expect(emoji.custom_emoji.backup_asset.sha256).toBe(
      canonical[0]?.file.backup_asset.sha256,
    );

    const user = (await first.canonicalize(
      {
        object: "user",
        id: "99999999-9999-9999-9999-999999999999",
        avatar_url: "data:text/plain;base64,aGVsbG8=",
        request_id: "volatile-top-level",
        nested: { request_id: "volatile-nested" },
      },
      "user",
    )) as {
      avatar_url: { backup_asset: { sha256: string } };
      request_id?: string;
      nested: { request_id?: string };
    };
    expect(user.avatar_url.backup_asset.sha256).toBe(
      canonical[0]?.file.backup_asset.sha256,
    );
    expect(user.request_id).toBeUndefined();
    expect(user.nested.request_id).toBeUndefined();
    await first.finalize();

    const secondOutput = await outputDirectory();
    const noNetwork = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    const second = new AssetManager({
      writer: new SnapshotWriter(secondOutput),
      previous: firstOutput,
      concurrency: 1,
      logger: silentLogger(),
      fetch: noNetwork as typeof fetch,
    });
    const reused = (await second.canonicalize(input, "fixture")) as {
      file: { backup_asset: { path: string } };
    };
    await second.finalize();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(
      await readFile(join(secondOutput, reused.file.backup_asset.path), "utf8"),
    ).toBe("hello");
  });

  it("names the failing asset and its cause without the signed query", async () => {
    const warn = vi.fn();
    const failing = vi.fn(async () => new Response("denied", { status: 403 }));
    const manager = new AssetManager({
      writer: new SnapshotWriter(await outputDirectory()),
      concurrency: 1,
      logger: { ...silentLogger(), warn },
      fetch: failing as typeof fetch,
    });
    const input = {
      type: "file",
      name: "doc.pdf",
      file: { url: "https://files.example/ws/doc.pdf?X-Amz-Signature=secret" },
    };
    const error = await manager
      .canonicalize(input, "page:abc.properties.Files")
      .then(
        () => new Error("unexpected success"),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toContain("https://files.example/ws/doc.pdf");
    expect(error.message).toContain("page:abc.properties.Files");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain("secret");
    expect(warn).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  }, 15_000);
});

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "notion-assets-"));
  await mkdir(join(root, "assets", "sha256"), { recursive: true });
  await mkdir(join(root, "assets", "metadata"), { recursive: true });
  return root;
}
