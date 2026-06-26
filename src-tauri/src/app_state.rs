//! Tauri managed state (PLAN §1.1, §1.5). The single `Arc<Mutex<EngineState>>`
//! authority + DB-backed settings + the SQLite pool + tray gating cursor + the
//! current session's start marker (for writing a session row on clock-out).

use sqlx::SqlitePool;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex as TokioMutex;

use crate::engine::EngineState;
use crate::ipc::SettingsDto;

/// Marks where the current working session began, so clock-out can compute the
/// session's active seconds + earnings for the `sessions` table.
#[derive(Debug, Clone)]
pub struct SessionStart {
    pub id: String,
    pub start_wall: String, // RFC3339 local
    pub start_accumulated_secs: f64,
    pub start_cents: i64,
}

pub struct AppState {
    /// The one and only earnings authority, driven by the 1 Hz loop (clock.rs).
    pub engine: TokioMutex<EngineState>,
    /// User settings, mirrored to SQLite (`settings` table) on every update.
    pub settings: TokioMutex<SettingsDto>,
    /// Durable persistence pool — engine writes the truth directly (PLAN §1.2).
    pub db: SqlitePool,
    /// Last today-cents pushed to the macOS menubar title — gates redraws.
    pub last_tray_cents: StdMutex<i64>,
    /// Start marker for the in-progress session (None when idle).
    pub session_start: StdMutex<Option<SessionStart>>,
    /// Highest milestone (cents) already fired today — gates one-shot notifications,
    /// reset to 0 on rollover (PLAN §6 / D3: per-day milestones).
    pub last_milestone_cents: StdMutex<i64>,
}

impl AppState {
    pub fn new(
        engine: EngineState,
        settings: SettingsDto,
        db: SqlitePool,
        last_milestone_cents: i64,
    ) -> Self {
        Self {
            engine: TokioMutex::new(engine),
            settings: TokioMutex::new(settings),
            db,
            last_tray_cents: StdMutex::new(i64::MIN),
            session_start: StdMutex::new(None),
            last_milestone_cents: StdMutex::new(last_milestone_cents),
        }
    }
}
