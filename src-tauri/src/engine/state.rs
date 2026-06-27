//! Engine state machine + derived read-outs (PLAN §1.5). Pure: no OS clock, no
//! webview. The single `Arc<Mutex<EngineState>>` authority lives in the Tauri
//! managed state (M2); this module is the deterministic core it wraps.

use chrono::NaiveDate;
use serde::Serialize;

use super::rate;

/// Engine status. Serializes lowercase to match the TS `EngineStatus` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Working,
    Paused,
}

/// Computed engine parameters (derived from `SettingsDto` by the commands layer).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineSettings {
    pub rate_millicents_per_sec: u64,
    pub daily_threshold_secs: u64,
    pub overtime_mult_x100: u64,
}

impl EngineSettings {
    /// Build from the raw pay model (PLAN §1.1).
    pub fn from_pay_model(
        monthly_salary_cents: u64,
        workdays_per_month: u64,
        daily_hours: f64,
        overtime_mult_x100: u64,
    ) -> Self {
        let daily_threshold_secs = rate::daily_threshold_secs(daily_hours);
        let rate_millicents_per_sec = rate::rate_millicents_per_sec(
            monthly_salary_cents,
            workdays_per_month,
            daily_threshold_secs,
        );
        Self {
            rate_millicents_per_sec,
            daily_threshold_secs,
            overtime_mult_x100: overtime_mult_x100.max(100), // never below 1.0×
        }
    }
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            rate_millicents_per_sec: 0,
            daily_threshold_secs: 28800, // 8h
            overtime_mult_x100: 150,
        }
    }
}

/// The single source of truth. `accumulated_active_secs` is **current local day
/// only** (reset at midnight, because overtime is reckoned per day). The
/// `SuspendUnawareInstant` anchor that drives accumulation lives in the live loop
/// (M2) — never here, since an `Instant` is meaningless across process restarts.
#[derive(Debug, Clone)]
pub struct EngineState {
    pub status: Status,
    pub settings: EngineSettings,
    pub current_local_date: NaiveDate,
    /// Total active seconds worked on `current_local_date` (across sessions today).
    pub accumulated_active_secs: f64,
    /// Accumulator value when the current session started — sessionCents = today − anchor.
    pub session_anchor_active_secs: f64,
    pub session_id: Option<String>,
}

impl EngineState {
    pub fn new(settings: EngineSettings, today: NaiveDate) -> Self {
        Self {
            status: Status::Idle,
            settings,
            current_local_date: today,
            accumulated_active_secs: 0.0,
            session_anchor_active_secs: 0.0,
            session_id: None,
        }
    }

    // ---- transitions (PLAN §1.5: Idle → Working → Paused → … → Idle) ----

    /// Clock in. Only meaningful from Idle; the caller supplies a fresh session id
    /// (injected so the core stays deterministic / testable). Returns true if the
    /// transition actually happened.
    pub fn start(&mut self, session_id: String) -> bool {
        if self.status != Status::Idle {
            return false;
        }
        self.status = Status::Working;
        self.session_id = Some(session_id);
        // a new session/stretch starts measuring from the current day total
        self.session_anchor_active_secs = self.accumulated_active_secs;
        true
    }

    /// 摸鱼 — freeze accumulation (active increment is 0 while not Working).
    pub fn pause(&mut self) -> bool {
        if self.status != Status::Working {
            return false;
        }
        self.status = Status::Paused;
        true
    }

    pub fn resume(&mut self) -> bool {
        if self.status != Status::Paused {
            return false;
        }
        self.status = Status::Working;
        true
    }

    /// 下班 — end the session. Today's accumulated total is retained (you still
    /// earned it today); a later start the same day keeps adding to it.
    pub fn stop(&mut self) -> bool {
        if self.status == Status::Idle {
            return false;
        }
        self.status = Status::Idle;
        self.session_id = None;
        true
    }

    /// Apply recomputed settings (M4). Accumulator is untouched, so today's
    /// earnings simply re-derive at the new rate on the next tick.
    pub fn apply_settings(&mut self, settings: EngineSettings) {
        self.settings = settings;
    }

    // ---- derived read-outs (used by tick + get_snapshot) ----

    pub fn today_cents(&self) -> i64 {
        rate::earnings_cents(
            self.accumulated_active_secs,
            self.settings.daily_threshold_secs,
            self.settings.rate_millicents_per_sec,
            self.settings.overtime_mult_x100,
        )
    }

    /// Marginal earnings since the current session started (within the day).
    /// 0 when idle. Resets at midnight (session anchor follows the day).
    pub fn session_cents(&self) -> i64 {
        if self.status == Status::Idle {
            return 0;
        }
        let anchor = rate::earnings_cents(
            self.session_anchor_active_secs,
            self.settings.daily_threshold_secs,
            self.settings.rate_millicents_per_sec,
            self.settings.overtime_mult_x100,
        );
        (self.today_cents() - anchor).max(0)
    }

    pub fn session_active_secs(&self) -> f64 {
        if self.status == Status::Idle {
            return 0.0;
        }
        (self.accumulated_active_secs - self.session_anchor_active_secs).max(0.0)
    }

    pub fn is_overtime(&self) -> bool {
        rate::is_overtime(
            self.accumulated_active_secs,
            self.settings.daily_threshold_secs,
        )
    }

    pub fn per_second_cents(&self) -> f64 {
        rate::per_second_cents(
            self.accumulated_active_secs,
            self.settings.daily_threshold_secs,
            self.settings.rate_millicents_per_sec,
            self.settings.overtime_mult_x100,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 6, 27).unwrap()
    }

    fn settings() -> EngineSettings {
        // 1 cent/s, T = 100s, 2× overtime — small numbers for clear assertions.
        EngineSettings {
            rate_millicents_per_sec: 1000,
            daily_threshold_secs: 100,
            overtime_mult_x100: 200,
        }
    }

    #[test]
    fn fresh_state_is_idle() {
        let s = EngineState::new(settings(), date());
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.today_cents(), 0);
        assert_eq!(s.session_cents(), 0);
        assert!(s.session_id.is_none());
    }

    #[test]
    fn transition_sequence() {
        let mut s = EngineState::new(settings(), date());
        assert!(s.start("sess-1".into()));
        assert_eq!(s.status, Status::Working);
        assert_eq!(s.session_id.as_deref(), Some("sess-1"));

        assert!(!s.start("sess-2".into())); // already working → no-op
        assert!(s.pause());
        assert_eq!(s.status, Status::Paused);
        assert!(!s.pause()); // can't pause twice
        assert!(s.resume());
        assert_eq!(s.status, Status::Working);
        assert!(s.stop());
        assert_eq!(s.status, Status::Idle);
        assert!(s.session_id.is_none());
        assert!(!s.resume()); // can't resume from idle
    }

    #[test]
    fn session_cents_is_marginal_within_day() {
        let mut s = EngineState::new(settings(), date());
        // pretend 50s already worked earlier today (e.g. a prior session)
        s.accumulated_active_secs = 50.0;
        s.start("sess".into());
        assert_eq!(s.session_anchor_active_secs, 50.0);
        // now 80s total → session earned 30 cents, today shows 80
        s.accumulated_active_secs = 80.0;
        assert_eq!(s.today_cents(), 80);
        assert_eq!(s.session_cents(), 30);
        assert_eq!(s.session_active_secs(), 30.0);
    }

    #[test]
    fn settings_change_reprices_accumulator() {
        let mut s = EngineState::new(settings(), date());
        s.accumulated_active_secs = 50.0;
        assert_eq!(s.today_cents(), 50);
        // double the rate → same time, double the money
        s.apply_settings(EngineSettings {
            rate_millicents_per_sec: 2000,
            ..settings()
        });
        assert_eq!(s.today_cents(), 100);
    }
}
