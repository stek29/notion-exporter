import { exportSnapshot, type CommentMode } from "../exporter/exporter.js";
import { createNotionApi } from "../notion/api.js";
import { BackupError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";

export interface ExportCommandOptions {
  roots: string[];
  skips: string[];
  output: string;
  cache?: string;
  comments: CommentMode;
  concurrency: number;
  requestsPerSecond: number;
  assetConcurrency: number;
  token: string;
  logger: Logger;
}

export async function runExport(options: ExportCommandOptions): Promise<void> {
  validatePositiveInteger(options.concurrency, "--concurrency");
  validatePositiveInteger(options.assetConcurrency, "--asset-concurrency");
  if (
    !(options.requestsPerSecond > 0) ||
    !Number.isFinite(options.requestsPerSecond)
  ) {
    throw new BackupError("--requests-per-second must be positive");
  }
  const api = createNotionApi({
    token: options.token,
    requestsPerSecond: options.requestsPerSecond,
    concurrency: options.concurrency,
    logger: options.logger,
  });
  await exportSnapshot({
    roots: options.roots,
    skips: options.skips,
    output: options.output,
    ...(options.cache ? { cache: options.cache } : {}),
    comments: options.comments,
    assetConcurrency: options.assetConcurrency,
    api,
    logger: options.logger,
  });
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new BackupError(`${name} must be a positive integer`);
}
