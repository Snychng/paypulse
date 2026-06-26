/**
 * useEngineControls — thin, memoized wrappers over the engine commands, shared by
 * the mini window, dashboard and popover. `toggle` maps the current status to the
 * right transition (idle→start, working→pause, paused→resume); `stop` is wired to
 * a long-press in the UI (anti mis-tap) but is a plain call here.
 */
import { useCallback, useMemo } from "react";

import {
  engineStart,
  enginePause,
  engineResume,
  engineStop,
} from "@/shared/ipc";
import type { EngineStatus } from "@/shared/types";

export interface EngineControls {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  /** idle→start, working→pause, paused→resume */
  toggle: (status: EngineStatus) => Promise<void>;
}

export function useEngineControls(): EngineControls {
  const start = useCallback(() => engineStart().then(() => undefined), []);
  const pause = useCallback(() => enginePause().then(() => undefined), []);
  const resume = useCallback(() => engineResume().then(() => undefined), []);
  const stop = useCallback(() => engineStop().then(() => undefined), []);

  const toggle = useCallback(
    (status: EngineStatus) => {
      if (status === "working") return pause();
      if (status === "paused") return resume();
      return start();
    },
    [start, pause, resume],
  );

  return useMemo(
    () => ({ start, pause, resume, stop, toggle }),
    [start, pause, resume, stop, toggle],
  );
}
