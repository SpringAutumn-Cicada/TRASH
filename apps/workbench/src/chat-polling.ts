import { useEffect, useEffectEvent } from "react";

/** Keep stable references for unchanged values in JSON responses. */
export function reuseChatSnapshot<T>(previous: T, next: T): T {
  return shareValue(previous, next) as T;
}

function shareValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object") return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    const items = next.map((item, index) => shareValue(previous[index], item));
    return previous.length === items.length && items.every((item, index) => item === previous[index]) ? previous : items;
  }
  if (Array.isArray(previous)) return next;
  const old = previous as Record<string, unknown>, incoming = next as Record<string, unknown>;
  const entries = Object.entries(incoming).map(([key, value]) => [key, shareValue(old[key], value)] as const);
  return Object.keys(old).length === entries.length && entries.every(([key, value]) => Object.hasOwn(old, key) && value === old[key])
    ? previous : Object.fromEntries(entries);
}

export function reuseChatRows<T>(previous: T[], next: T[], key: keyof T): T[] {
  const byId = new Map(previous.map(row => [row[key], row]));
  const rows = next.map(row => {
    const old = byId.get(row[key]);
    return old === undefined ? row : reuseChatSnapshot(old, row);
  });
  return previous.length === rows.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}

export function useChatPolling(scope: string, active: boolean, activeInterval: number, refresh: (signal: AbortSignal) => Promise<void>) {
  const refreshLatest = useEffectEvent(refresh);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    async function poll() {
      clearTimeout(timer);
      if (stopped || document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      try {
        await refreshLatest(controller.signal);
      } finally {
        request = undefined;
        if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), active ? activeInterval : 12000);
      }
    }

    const resume = () => { if (!document.hidden) void poll(); };
    const visibility = () => {
      if (document.hidden) clearTimeout(timer);
      else resume();
    };
    void poll();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, active, activeInterval]);
}
