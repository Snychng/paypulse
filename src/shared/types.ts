/**
 * Shared IPC contract types (PLAN §6 + §5).
 *
 * Wire convention: **camelCase** on the JSON boundary. The Rust side annotates
 * every emitted/returned struct with `#[serde(rename_all = "camelCase")]` so
 * these mirror 1:1. All money is integer **cents**; all durations integer secs.
 */

/** Engine status. Rust serializes lowercase (serde rename_all = "lowercase"). */
export type EngineStatus = "idle" | "working" | "paused";

/** Why a state-change fired (PLAN §6). */
export type ChangeReason = "user" | "rollover" | "sleep-resume" | "settings";

export type Theme = "system" | "dark" | "light" | "transparent" | "macaron";
export type Language = "system" | "zh" | "en";
/** 'auto' follows UI language (zh→CNY, en→USD) — symbol only, no FX (D2). */
export type Currency = "auto" | "CNY" | "USD";

/** `paypulse://tick` — emitted every wall-clock second to all windows. */
export interface TickPayload {
  todayCents: number;
  sessionCents: number;
  sessionActiveSecs: number;
  perSecondCents: number;
  state: EngineStatus;
  isOvertime: boolean;
  localDate: string; // ISO 'YYYY-MM-DD', local calendar day
  sessionId: string | null;
  milestoneHit: boolean;
}

/** `get_snapshot` — seeds a freshly-mounted window so it never paints a blank frame. */
export interface Snapshot {
  todayCents: number;
  sessionCents: number;
  sessionActiveSecs: number;
  perSecondCents: number;
  state: EngineStatus;
  isOvertime: boolean;
  localDate: string;
  sessionId: string | null;
}

/** `paypulse://state-changed` — start/pause/stop/settings/rollover/sleep. */
export interface StateChangedPayload {
  state: EngineStatus;
  sessionId: string | null;
  reason: ChangeReason;
  todayCents: number;
  sessionActiveSecs: number;
  localDate: string;
}

/** `paypulse://milestone` — fires exactly once when a milestone is crossed. */
export interface MilestonePayload {
  kind: string;
  amountCents: number;
  label: string;
}

/** Mirrors the SQLite `settings` row (PLAN §5), camelCased. */
export interface SettingsDto {
  monthlySalaryCents: number;
  dailyHours: number;
  workdaysPerMonth: number;
  overtimeMultiplierX100: number;
  milestonesCents: number[];
  theme: Theme;
  language: Language;
  currency: Currency;
  notificationsEnabled: boolean;
  autostartEnabled: boolean;
  windowsIconNumber: boolean;
  transparencyEnabled: boolean;
  miniOpacityX100: number; // 35–100
  displayDecimals: number; // 0–4, default 3
}

/** What the settings form sends to `update_settings`; Rust re-validates + recomputes rate. */
export type UpdateSettingsInput = SettingsDto;

export type StatsRange = "today" | "week" | "month";

export interface DayTotal {
  localDate: string;
  totalCents: number;
  activeSecs: number;
  overtimeSecs: number;
}

export interface StatsResult {
  range: StatsRange;
  days: DayTotal[];
  totalCents: number;
}
