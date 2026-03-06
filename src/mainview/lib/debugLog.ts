const lastLogAt = new Map<string, number>();

function serialize(data: unknown): string {
  if (data === undefined) return "";
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

export function debugLog(message: string, data?: unknown): void {
  const text = `[FEDBG] ${message}${serialize(data)}`;
  console.log(text);
  try {
    window.djRpc?.send?.logToBun?.({ msg: text });
  } catch {
    // Ignore logging transport failures in debug instrumentation.
  }
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
