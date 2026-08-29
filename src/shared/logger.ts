export type LogFormat = "human" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(format: LogFormat, verbose = false): Logger {
  const write = (
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (level === "debug" && !verbose) return;
    const safe = sanitize(fields);
    if (format === "json") {
      process.stderr.write(`${JSON.stringify({ level, message, ...safe })}\n`);
      return;
    }
    const suffix =
      safe && Object.keys(safe).length > 0 ? ` ${formatFields(safe)}` : "";
    process.stderr.write(
      `${level === "info" ? "" : `${level}: `}${message}${suffix}\n`,
    );
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function sanitize(
  fields?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) => !/(token|authorization|signed.?url)/i.test(key),
    ),
  );
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
}
