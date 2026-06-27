/**
 * useEngineTick — the one hook every window uses to read live earnings (PLAN §1.5).
 *
 * The hero figure is driven through a **MotionValue**, not React state: each 1 Hz
 * `tick` re-anchors the spring target, and `useSpring` interpolates at 60/120 fps
 * without re-rendering the component tree. Secondary fields (status, ¥/s, session)
 * live in a single `meta` state that updates at 1 Hz — cheap, and never per-frame.
 *
 * Both channels feed it: `tick` (every second) and `state-changed` (immediate on a
 * button press, plus rollover/sleep), so the UI reflects user actions without
 * waiting for the next beat. Re-anchoring to Rust's integer-cent truth each tick
 * makes drift impossible.
 */
import { useEffect, useState } from "react";
import { useMotionValue, useSpring } from "motion/react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { listenTick, listenStateChanged } from "@/shared/events";
import { getSnapshot } from "@/shared/ipc";
import type { EngineStatus } from "@/shared/types";

export interface TickMeta {
  todayCents: number;
  sessionCents: number;
  sessionActiveSecs: number;
  perSecondCents: number;
  status: EngineStatus;
  isOvertime: boolean;
  localDate: string;
  sessionId: string | null;
}

const INITIAL_META: TickMeta = {
  todayCents: 0,
  sessionCents: 0,
  sessionActiveSecs: 0,
  perSecondCents: 0,
  status: "idle",
  isOvertime: false,
  localDate: "",
  sessionId: null,
};

export interface UseEngineTick extends TickMeta {
  /** Spring-smoothed today-cents MotionValue — bind via useTransform → textContent. */
  todaySpring: ReturnType<typeof useSpring>;
}

export function useEngineTick(): UseEngineTick {
  const todayTarget = useMotionValue(0);
  const todaySpring = useSpring(todayTarget, { stiffness: 300, damping: 30 });
  const [meta, setMeta] = useState<TickMeta>(INITIAL_META);

  useEffect(() => {
    let alive = true;
    const unlisteners: UnlistenFn[] = [];

    // seed immediately so the window never paints a blank frame
    getSnapshot()
      .then((s) => {
        if (!alive) return;
        todayTarget.set(s.todayCents); // springs up from 0 → a pleasant launch count-up
        setMeta({
          todayCents: s.todayCents,
          sessionCents: s.sessionCents,
          sessionActiveSecs: s.sessionActiveSecs,
          perSecondCents: s.perSecondCents,
          status: s.state,
          isOvertime: s.isOvertime,
          localDate: s.localDate,
          sessionId: s.sessionId,
        });
      })
      .catch(() => {
        /* not in a Tauri webview (e.g. plain `vite preview`) — stay at zero */
      });

    listenTick((p) => {
      todayTarget.set(p.todayCents);
      setMeta({
        todayCents: p.todayCents,
        sessionCents: p.sessionCents,
        sessionActiveSecs: p.sessionActiveSecs,
        perSecondCents: p.perSecondCents,
        status: p.state,
        isOvertime: p.isOvertime,
        localDate: p.localDate,
        sessionId: p.sessionId,
      });
    })
      .then((u) => (alive ? unlisteners.push(u) : u()))
      .catch(() => {
        /* not in a Tauri webview — no event bus */
      });

    listenStateChanged((p) => {
      todayTarget.set(p.todayCents);
      // status/date change immediately; ¥/s + session refresh on the next tick
      setMeta((prev) => ({
        ...prev,
        todayCents: p.todayCents,
        sessionActiveSecs: p.sessionActiveSecs,
        status: p.state,
        localDate: p.localDate,
        sessionId: p.sessionId,
      }));
    })
      .then((u) => (alive ? unlisteners.push(u) : u()))
      .catch(() => {
        /* not in a Tauri webview — no event bus */
      });

    return () => {
      alive = false;
      for (const u of unlisteners) u();
    };
    // todayTarget identity is stable across renders (useMotionValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...meta, todaySpring };
}
