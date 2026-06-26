/**
 * Typed JS→Rust command wrappers (PLAN §6). React holds zero money authority;
 * every mutation goes through the Rust engine, which recomputes + persists.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Snapshot,
  SettingsDto,
  UpdateSettingsInput,
  StatsRange,
  StatsResult,
} from "./types";

export const engineStart = (): Promise<void> => invoke("engine_start");
export const enginePause = (): Promise<void> => invoke("engine_pause");
export const engineResume = (): Promise<void> => invoke("engine_resume");
export const engineStop = (): Promise<void> => invoke("engine_stop");

/** Seed a freshly-mounted window with the current engine state. */
export const getSnapshot = (): Promise<Snapshot> => invoke("get_snapshot");

export const getSettings = (): Promise<SettingsDto> => invoke("get_settings");

/** Rust re-validates, recomputes the per-second rate + daily threshold, persists. */
export const updateSettings = (
  settings: UpdateSettingsInput,
): Promise<SettingsDto> => invoke("update_settings", { settings });

export const setAutostart = (enabled: boolean): Promise<void> =>
  invoke("set_autostart", { enabled });

export const getStats = (range: StatsRange): Promise<StatsResult> =>
  invoke("get_stats", { range });

export const toggleMini = (): Promise<void> => invoke("toggle_mini");

export const openSettingsWindow = (): Promise<void> =>
  invoke("open_settings_window");
