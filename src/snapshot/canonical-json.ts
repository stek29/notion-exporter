import type { JsonValue } from "../shared/types.js";

export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)] as const);
    return Object.fromEntries(entries);
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function stringifyCanonical(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
