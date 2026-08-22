export type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  scoped(scope: string): Logger;
};

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function formatFields(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

export function createLogger(minLevel: Level, scope = ""): Logger {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < RANK[minLevel]) return;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    const at = new Date().toISOString();
    const where = scope === "" ? "" : ` [${scope}]`;
    stream.write(`${at} ${level.toUpperCase().padEnd(5)}${where} ${message}${fields ? formatFields(fields) : ""}\n`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    scoped: (child) => createLogger(minLevel, scope === "" ? child : `${scope}:${child}`),
  };
}
