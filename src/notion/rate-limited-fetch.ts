import type { Logger } from "../shared/logger.js";

export interface RateLimitOptions {
  requestsPerSecond: number;
  concurrency: number;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
}

export function createRateLimitedFetch(
  options: RateLimitOptions,
): typeof globalThis.fetch {
  const scheduler = new RequestScheduler(
    options.requestsPerSecond,
    options.concurrency,
  );
  const underlying = options.fetch ?? globalThis.fetch;

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await scheduler.run(() => underlying(input, init));
        if (!isRetryableStatus(response.status) || attempt === 5)
          return response;
        await response.body?.cancel().catch(() => undefined);

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const backoff =
          retryAfter ??
          Math.min(60_000, 1_000 * 2 ** attempt) +
            Math.floor(Math.random() * 500);
        if (response.status === 429 || response.status === 529) {
          scheduler.pause(backoff);
          options.logger.warn("Notion requested a global API cooldown", {
            status: response.status,
            retry_after_ms: backoff,
          });
        } else {
          await delay(backoff);
        }
      } catch (error) {
        lastError = error;
        if (attempt === 5 || init?.signal?.aborted) throw error;
        await delay(
          Math.min(60_000, 1_000 * 2 ** attempt) +
            Math.floor(Math.random() * 500),
        );
      }
    }
    throw lastError;
  };
}

export class RequestScheduler {
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private active = 0;
  private nextStart = 0;
  private blockedUntil = 0;
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(requestsPerSecond: number, concurrency: number) {
    if (!(requestsPerSecond > 0) || !Number.isFinite(requestsPerSecond)) {
      throw new RangeError("requestsPerSecond must be positive");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    this.intervalMs = 1_000 / requestsPerSecond;
    this.concurrency = concurrency;
  }

  public pause(milliseconds: number): void {
    this.blockedUntil = Math.max(
      this.blockedUntil,
      Date.now() + Math.max(0, milliseconds),
    );
    this.schedule();
  }

  public run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active += 1;
        this.nextStart = Date.now() + this.intervalMs;
        void operation()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.schedule();
          });
      });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0 || this.active >= this.concurrency) return;
    const wait = Math.max(
      0,
      this.nextStart - Date.now(),
      this.blockedUntil - Date.now(),
    );
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, wait);
      return;
    }
    this.queue.shift()?.();
    this.schedule();
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504, 529].includes(status);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
