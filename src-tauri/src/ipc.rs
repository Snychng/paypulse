//! IPC payload + DTO definitions (PLAN §6). Every struct is camelCased on the wire
//! to mirror `src/shared/types.ts` 1:1. All money is integer **cents**.

use serde::{Deserialize, Serialize};

use crate::engine::Status;

pub const EVENT_TICK: &str = "paypulse://tick";
pub const EVENT_STATE_CHANGED: &str = "paypulse://state-changed";
pub const EVENT_MILESTONE: &str = "paypulse://milestone";

/// Why a `state-changed` fired (PLAN §6). kebab-case → "user" | "rollover" |
/// "sleep-resume" | "settings".
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeReason {
    User,
    Rollover,
    SleepResume,
    Settings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickPayload {
    pub today_cents: i64,
    pub session_cents: i64,
    pub session_active_secs: f64,
    pub per_second_cents: f64,
    pub state: Status,
    pub is_overtime: bool,
    pub local_date: String,
    pub session_id: Option<String>,
    pub milestone_hit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub today_cents: i64,
    pub session_cents: i64,
    pub session_active_secs: f64,
    pub per_second_cents: f64,
    pub state: Status,
    pub is_overtime: bool,
    pub local_date: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChangedPayload {
    pub state: Status,
    pub session_id: Option<String>,
    pub reason: ChangeReason,
    pub today_cents: i64,
    pub session_active_secs: f64,
    pub local_date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestonePayload {
    pub kind: String,
    pub amount_cents: i64,
    pub label: String,
}

/// Mirrors the SQLite `settings` row (PLAN §5). Persisted in M5; held in memory in M2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub monthly_salary_cents: u64,
    pub daily_hours: f64,
    pub workdays_per_month: u64,
    pub overtime_multiplier_x100: u64,
    pub milestones_cents: Vec<i64>,
    pub theme: String,
    pub language: String,
    pub currency: String,
    pub notifications_enabled: bool,
    pub autostart_enabled: bool,
    pub windows_icon_number: bool,
    pub transparency_enabled: bool,
    pub mini_opacity_x100: u64,
    pub display_decimals: u8,
}

impl Default for SettingsDto {
    fn default() -> Self {
        Self {
            monthly_salary_cents: 0,
            daily_hours: 8.0,
            workdays_per_month: 22,
            overtime_multiplier_x100: 150,
            milestones_cents: Vec::new(),
            theme: "system".into(),
            language: "system".into(),
            currency: "auto".into(),
            notifications_enabled: true,
            autostart_enabled: false,
            windows_icon_number: false,
            transparency_enabled: true,
            mini_opacity_x100: 92,
            display_decimals: 3,
        }
    }
}

impl SettingsDto {
    /// Derive the engine's computed parameters from this pay model (PLAN §1.1).
    pub fn to_engine_settings(&self) -> crate::engine::EngineSettings {
        crate::engine::EngineSettings::from_pay_model(
            self.monthly_salary_cents,
            self.workdays_per_month,
            self.daily_hours,
            self.overtime_multiplier_x100,
        )
    }
}

/// `get_stats` range selector (PLAN §6). lowercase on the wire.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatsRange {
    Today,
    Week,
    Month,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    pub local_date: String,
    pub total_cents: i64,
    pub active_secs: i64,
    pub overtime_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsResult {
    pub range: String,
    pub days: Vec<DayTotal>,
    pub total_cents: i64,
}
