import type { Logger } from "../shared/logger.js";

export interface RateLimitOptions {
  requestsPerSecond: number;
  concurrency: number;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  progressEvery?: number;
}

export function createRateLimitedFetch(
  options: RateLimitOptions,
): typeof globalThis.fetch {
  const scheduler = new RequestScheduler(
    options.requestsPerSecond,
    options.concurrency,
  );
  const underlying = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const progressEvery = options.progressEvery ?? 100;
  let requestsCompleted = 0;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
    throw new RangeError("requestTimeoutMs must be positive");
  if (!Number.isInteger(progressEvery) || progressEvery <= 0)
    throw new RangeError("progressEvery must be a positive integer");

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await scheduler.run(() => {
          // Start the timeout only after this request owns a scheduler slot;
          // time spent waiting behind the global limiter is not network time.
          const attemptTimeout = AbortSignal.timeout(requestTimeoutMs);
          const signal = init?.signal
            ? AbortSignal.any([init.signal, attemptTimeout])
            : attemptTimeout;
          return underlying(input, { ...init, signal });
        });
        if (!isRetryableStatus(response.status) || attempt === 5) {
          requestsCompleted += 1;
          if (requestsCompleted % progressEvery === 0) {
            options.logger.info("Notion API progress", {
              requests_completed: requestsCompleted,
            });
          }
          return response;
        }
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
        options.logger.warn("Retrying a transient Notion request failure", {
          attempt: attempt + 1,
          reason: isTimeout(error) ? "timeout" : "network",
        });
        await delay(
          Math.min(60_000, 1_000 * 2 ** attempt) +
            Math.floor(Math.random() * 500),
        );
      }
    }
    throw lastError;
  };
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
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
