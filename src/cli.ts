#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { runExport } from "./commands/export.js";
import { runVerify } from "./commands/verify.js";
import { loadExportConfig } from "./config/export.js";
import { loadNotionToken } from "./config/token.js";
import { EXPORTER_VERSION } from "./constants.js";
import type { CommentMode } from "./exporter/exporter.js";
import { errorMessage, VerificationError } from "./shared/errors.js";
import { createLogger, type LogFormat } from "./shared/logger.js";

interface CommonOptions {
  logFormat: LogFormat;
  verbose?: boolean;
}

const program = new Command()
  .name("notion-backup")
  .description("Create and verify deterministic Notion subtree snapshots")
  .version(EXPORTER_VERSION)
  .showHelpAfterError();

let activeLogFormat: LogFormat = "human";
let activeVerbose = false;

program
  .command("export")
  .description("Export a complete snapshot from one or more configured roots")
  .option(
    "--root <id-or-url>",
    "Notion root UUID or URL; repeat for multiple roots",
    collect,
    [],
  )
  .option(
    "--skip <id-or-url>",
    "omit this object and cut traversal through it; repeat for multiple IDs",
    collect,
    [],
  )
  .option("--config <path>", "JSON file containing roots and skips")
  .requiredOption("--output <path>", "empty output directory")
  .option(
    "--incremental-from <path>",
    "reuse unchanged resources and assets from a previous snapshot",
  )
  .addOption(
    new Option("--comments <mode>", "comment export mode")
      .choices(["none", "all"])
      .default("none"),
  )
  .addOption(
    new Option(
      "--concurrency <number>",
      "maximum concurrent Notion API requests",
    )
      .default(3)
      .argParser(integer),
  )
  .addOption(
    new Option(
      "--requests-per-second <number>",
      "proactive Notion request rate",
    )
      .default(2.5)
      .argParser(positiveNumber),
  )
  .addOption(
    new Option(
      "--asset-concurrency <number>",
      "maximum concurrent asset downloads",
    )
      .default(4)
      .argParser(integer),
  )
  .addOption(
    new Option("--log-format <format>", "human or json")
      .choices(["human", "json"])
      .default("human"),
  )
  .option("--verbose", "enable debug progress logs")
  .action(
    async (
      options: CommonOptions & {
        root: string[];
        skip: string[];
        config?: string;
        output: string;
        incrementalFrom?: string;
        comments: CommentMode;
        concurrency: number;
        requestsPerSecond: number;
        assetConcurrency: number;
      },
    ) => {
      activeLogFormat = options.logFormat;
      activeVerbose = options.verbose ?? false;
      const logger = createLogger(activeLogFormat, activeVerbose);
      const config = options.config
        ? await loadExportConfig(options.config)
        : { roots: [], skips: [] };
      await runExport({
        roots: [...config.roots, ...options.root],
        skips: [...config.skips, ...options.skip],
        output: options.output,
        ...(options.incrementalFrom
          ? { incrementalFrom: options.incrementalFrom }
          : {}),
        comments: options.comments,
        concurrency: options.concurrency,
        requestsPerSecond: options.requestsPerSecond,
        assetConcurrency: options.assetConcurrency,
        token: await loadNotionToken(),
        logger,
      });
    },
  );

program
  .command("verify")
  .description("Verify a snapshot entirely offline")
  .argument("<path>", "snapshot directory")
  .addOption(
    new Option("--log-format <format>", "human or json")
      .choices(["human", "json"])
      .default("human"),
  )
  .option("--verbose", "enable debug logs")
  .action(async (path: string, options: CommonOptions) => {
    activeLogFormat = options.logFormat;
    activeVerbose = options.verbose ?? false;
    await runVerify(path, createLogger(activeLogFormat, activeVerbose));
  });

program.parseAsync().catch((error: unknown) => {
  const logger = createLogger(activeLogFormat, activeVerbose);
  logger.error(errorMessage(error));
  if (error instanceof VerificationError) {
    for (const problem of error.errors) logger.error(`- ${problem}`);
  }
  process.exitCode = 1;
});

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new InvalidArgumentError("expected a positive integer");
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!(parsed > 0) || !Number.isFinite(parsed))
    throw new InvalidArgumentError("expected a positive number");
  return parsed;
}
