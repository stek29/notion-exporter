import { describe, expect, it, vi } from "vitest";
import { createRateLimitedFetch } from "../src/notion/rate-limited-fetch.js";
import { silentLogger } from "./helpers/mock-api.js";

describe("rate-limited fetch", () => {
  it("retries rate limits through the same global scheduler", async () => {
    const underlying = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const limited = createRateLimitedFetch({
      requestsPerSecond: 1_000,
      concurrency: 1,
      logger: silentLogger(),
      fetch: underlying,
    });
    const response = await limited("https://api.notion.com/v1/users");
    expect(await response.text()).toBe("ok");
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("aborts and retries a timed-out network attempt", async () => {
    const underlying = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const limited = createRateLimitedFetch({
      requestsPerSecond: 1_000,
      concurrency: 1,
      requestTimeoutMs: 5,
      logger: silentLogger(),
      fetch: underlying,
    });

    const response = await limited("https://api.notion.com/v1/users");

    expect(await response.text()).toBe("ok");
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("does not count time waiting in the scheduler queue as request time", async () => {
    const underlying = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response("ok", { status: 200 });
    });
    const limited = createRateLimitedFetch({
      requestsPerSecond: 20,
      concurrency: 1,
      requestTimeoutMs: 5,
      logger: silentLogger(),
      fetch: underlying,
    });

    const responses = await Promise.all([
      limited("https://api.notion.com/v1/pages/one"),
      limited("https://api.notion.com/v1/pages/two"),
    ]);

    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["ok", "ok"]);
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("reports periodic progress for long request queues", async () => {
    const info = vi.fn();
    const limited = createRateLimitedFetch({
      requestsPerSecond: 1_000,
      concurrency: 2,
      progressEvery: 2,
      logger: {
        ...silentLogger(),
        info,
      },
      fetch: vi.fn<typeof fetch>(async () => new Response("ok")),
    });

    await Promise.all([
      limited("https://api.notion.com/v1/pages/one"),
      limited("https://api.notion.com/v1/pages/two"),
      limited("https://api.notion.com/v1/pages/three"),
    ]);

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Notion API progress", {
      requests_completed: 2,
    });
  });
});
