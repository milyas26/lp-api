const lastCall = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET JSON with timeout, retries on 429/5xx, and a per-host minimum spacing
 * so free public APIs (GeckoTerminal ~30 req/min) don't ban us.
 */
export async function getJson<T>(
  url: string,
  opts: { minSpacingMs?: number; retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const { minSpacingMs = 0, retries = 2, timeoutMs = 15_000 } = opts;
  const host = new URL(url).host;

  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + minSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1_000 * (attempt + 1));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
}
