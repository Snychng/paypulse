/**
 * useMilestone — subscribe to `paypulse://milestone` and run a celebration callback
 * (e.g. a CoinFlow burst). The OS notification itself is fired once from Rust
 * (single source, gated by notificationsEnabled), so this is purely visual.
 */
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { listenMilestone } from "@/shared/events";
import type { MilestonePayload } from "@/shared/types";

export function useMilestone(onHit: (m: MilestonePayload) => void): void {
  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;

    listenMilestone((m) => onHit(m))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {
        /* not in a Tauri webview */
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [onHit]);
}
