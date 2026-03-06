const lastLogAt = new Map<string, number>();
const LOG_LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof LOG_LEVEL_ORDER;

function serialize(data: unknown): string {
  if (data === undefined) return "";
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

function getLogLevel(): LogLevel {
  try {
    const configured = window.localStorage?.getItem("jensdj-log-level");
    if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") {
      return configured;
    }
  } catch {
    // Ignore storage access failures.
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[getLogLevel()];
}

function emitLog(level: LogLevel, message: string, data?: unknown): void {
  if (!shouldLog(level)) return;
  const text = `[UI:${level.toUpperCase()}] ${message}${serialize(data)}`;
  const logMethod = level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : console.log;
  logMethod(text);
  try {
    window.djRpc?.send?.logToBun?.({ msg: text });
  } catch {
    // Ignore logging transport failures.
  }
}

export function logInfo(message: string, data?: unknown): void {
  emitLog("info", message, data);
}

export function logWarn(message: string, data?: unknown): void {
  emitLog("warn", message, data);
}

export function logError(message: string, data?: unknown): void {
  emitLog("error", message, data);
}

export function debugLog(message: string, data?: unknown): void {
  emitLog("debug", message, data);
}

export function debugLogThrottled(
  key: string,
  intervalMs: number,
  message: string,
  data?: unknown
): void {
  const now = Date.now();
  const last = lastLogAt.get(key) ?? 0;
  if (now - last < intervalMs) return;
  lastLogAt.set(key, now);
  debugLog(message, data);
}

export function infoLogThrottled(
  key: string,
  intervalMs: number,
  message: string,
  data?: unknown
): void {
  const now = Date.now();
  const last = lastLogAt.get(key) ?? 0;
  if (now - last < intervalMs) return;
  lastLogAt.set(key, now);
  logInfo(message, data);
}
