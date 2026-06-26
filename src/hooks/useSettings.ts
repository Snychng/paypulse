/**
 * useSettings — load the settings DTO and keep it fresh when any window edits it.
 * Rust broadcasts `state-changed` with `reason: "settings"` after `update_settings`,
 * so we re-fetch on that signal (the event itself doesn't carry the new settings).
 */
import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { listenStateChanged } from "@/shared/events";
import { getSettings } from "@/shared/ipc";
import type { SettingsDto } from "@/shared/types";

export interface UseSettings {
  settings: SettingsDto | null;
  reload: () => void;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;

    getSettings()
      .then((s) => alive && setSettings(s))
      .catch(() => {
        /* not in a Tauri webview */
      });

    listenStateChanged((p) => {
      if (p.reason === "settings") {
        getSettings()
          .then((s) => alive && setSettings(s))
          .catch(() => {});
      }
    })
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {
        /* not in a Tauri webview — no event bus */
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [nonce]);

  return { settings, reload: () => setNonce((n) => n + 1) };
}
