import { readFile } from "node:fs/promises";
import { BackupError } from "../shared/errors.js";

export interface ExportConfig {
  roots: string[];
  skips: string[];
}

export async function loadExportConfig(path: string): Promise<ExportConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new BackupError(`Could not read export config: ${path}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new BackupError(`Export config is not valid JSON: ${path}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed))
    throw new BackupError("Export config must be a JSON object");

  return {
    roots: readStringArray(parsed, "roots"),
    skips: readStringArray(parsed, "skips"),
  };
}

function readStringArray(
  config: Record<string, unknown>,
  name: "roots" | "skips",
): string[] {
  const value = config[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new BackupError(
      `Export config \"${name}\" must be an array of strings`,
    );
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
