type Level = "info" | "warn" | "error";

const colors: Record<Level, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

function emit(level: Level, msg: string, extra: unknown[]): void {
  const ts = new Date().toISOString();
  const tag = `${colors[level]}${level.toUpperCase()}\x1b[0m`;
  const line = `${ts} ${tag} ${msg}`;
  if (level === "error") console.error(line, ...extra);
  else console.log(line, ...extra);
}

export const log = {
  info: (msg: string, ...extra: unknown[]) => emit("info", msg, extra),
  warn: (msg: string, ...extra: unknown[]) => emit("warn", msg, extra),
  error: (msg: string, ...extra: unknown[]) => emit("error", msg, extra),
};
