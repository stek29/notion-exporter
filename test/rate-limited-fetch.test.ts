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
});
