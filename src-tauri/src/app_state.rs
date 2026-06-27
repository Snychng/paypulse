//! Tauri managed state (PLAN §1.1, §1.5). The single `Arc<Mutex<EngineState>>`
//! authority + DB-backed settings + the SQLite pool + tray gating cursor + the
//! current session's start marker (for writing a session row on clock-out).

use chrono::{DateTime, Local};
use sqlx::SqlitePool;
use std::sync::Mutex as StdMutex;
use suspend_time::SuspendUnawareInstant;
use tokio::sync::Mutex as TokioMutex;

use crate::engine::{EngineState, TickInput};
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

/// Shared clock cursor for both the 1 Hz loop and user-triggered transitions.
/// Advancing it before a start/pause/resume/stop keeps billing anchored to the
/// actual click time instead of the next scheduled tick.
pub struct ClockCursor {
    last_wall: DateTime<Local>,
    last_mono: SuspendUnawareInstant,
}

impl ClockCursor {
    fn new() -> Self {
        Self {
            last_wall: Local::now(),
            last_mono: SuspendUnawareInstant::now(),
        }
    }

    pub fn next_tick_input(&mut self) -> TickInput {
        let now_wall = Local::now();
        let now_mono = SuspendUnawareInstant::now();
        let wall_delta = (now_wall - self.last_wall).num_milliseconds().max(0) as f64 / 1000.0;
        let mono_delta = (now_mono - self.last_mono).as_secs_f64();

        self.last_wall = now_wall;
        self.last_mono = now_mono;

        TickInput {
            mono_delta_secs: mono_delta,
            wall_delta_secs: wall_delta,
            wall_now: now_wall,
        }
    }
}

pub struct AppState {
    /// The one and only earnings authority, driven by the 1 Hz loop (clock.rs).
    pub engine: TokioMutex<EngineState>,
    /// Monotonic/wall cursor shared by the loop and control commands.
    pub clock: TokioMutex<ClockCursor>,
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
            clock: TokioMutex::new(ClockCursor::new()),
            settings: TokioMutex::new(settings),
            db,
            last_tray_cents: StdMutex::new(i64::MIN),
            session_start: StdMutex::new(None),
            last_milestone_cents: StdMutex::new(last_milestone_cents),
        }
    }
}
