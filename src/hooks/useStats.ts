/**
 * useStats — load aggregated day-totals for a range (PLAN §5/§6, M5). Refreshes on
 * `state-changed` (clock-out / rollover / settings all move day_totals) plus a slow
 * poll so the 15 s background flushes eventually surface. Money is integer cents.
 */
import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { listenStateChanged } from "@/shared/events";
import { getStats } from "@/shared/ipc";
import type { StatsRange, StatsResult } from "@/shared/types";

const POLL_MS = 20_000;

export function useStats(range: StatsRange): {
  stats: StatsResult | null;
  reload: () => void;
} {
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const fetchOnce = () =>
      getStats(range)
        .then((s) => alive && setStats(s))
        .catch(() => {
          /* not in a Tauri webview */
        });

    fetchOnce();
    timer = setInterval(fetchOnce, POLL_MS);

    listenStateChanged(() => {
      fetchOnce();
    })
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unlisten?.();
    };
  }, [range, nonce]);

  return { stats, reload: () => setNonce((n) => n + 1) };
}

/** Sum cents over a stats result (e.g. 本周/本月 total). */
export function sumCents(stats: StatsResult | null): number {
  return stats?.totalCents ?? 0;
}

/**
 * Map a week's sparse day_totals onto the last `count` calendar days ending at
 * `endDate` (ISO 'YYYY-MM-DD'), filling missing days with 0 — for the trend chart.
 * Returns oldest→newest.
 */
export function fillTrend(
  stats: StatsResult | null,
  endDate: string,
  count = 7,
): { localDate: string; totalCents: number }[] {
  const byDate = new Map<string, number>();
  for (const d of stats?.days ?? []) byDate.set(d.localDate, d.totalCents);

  const end = new Date(`${endDate}T00:00:00`);
  const out: { localDate: string; totalCents: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(end);
    dt.setDate(end.getDate() - i);
    const iso = dt.toISOString().slice(0, 10);
    out.push({ localDate: iso, totalCents: byDate.get(iso) ?? 0 });
  }
  return out;
}
