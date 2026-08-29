import { BackupError } from "./errors.js";

const COMPACT_UUID = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeNotionId(value: string): string {
  const trimmed = value.trim();
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    const matches = url.pathname.match(/[0-9a-f]{32}/gi);
    candidate = matches?.at(-1) ?? trimmed;
  } catch {
    // A raw ID is expected in the common case.
  }

  candidate = candidate.replaceAll("-", "").toLowerCase();
  if (!COMPACT_UUID.test(candidate)) {
    throw new BackupError(`Invalid Notion ID or URL: ${redactInput(trimmed)}`);
  }
  const normalized = [
    candidate.slice(0, 8),
    candidate.slice(8, 12),
    candidate.slice(12, 16),
    candidate.slice(16, 20),
    candidate.slice(20),
  ].join("-");
  if (!UUID.test(normalized)) {
    throw new BackupError(`Invalid Notion UUID: ${redactInput(trimmed)}`);
  }
  return normalized;
}

function redactInput(value: string): string {
  return value.length > 100 ? `${value.slice(0, 97)}...` : value;
}
