//! The per-beat algorithm (PLAN §1.5). Pure and deterministic: it takes the two
//! measured deltas + the local wall time and mutates `EngineState`. The live loop
//! (M2) measures `mono_delta` with `SuspendUnawareInstant` (sleep-unaware) and
//! `wall_delta` with the wall clock, then calls this. Tests drive it with synthetic
//! deltas to simulate sleep, rollover and overtime without any real clock.

use chrono::{DateTime, Duration, Local, NaiveDate};

use super::rate;
use super::rollover;
use super::state::{EngineState, Status};

/// A wall gap exceeding the monotonic gap by more than this ⇒ the machine slept
/// (PLAN §1.1 defense-in-depth). Accumulation already ignores it (mono ≈ 0), but
/// we surface the flag so the live loop can emit `reason = sleep-resume`.
pub const SLEEP_THRESHOLD_SECS: f64 = 5.0;

/// Inputs for one beat. `mono_delta_secs` is sleep-unaware active time; never used
/// for wall-clock dating. `wall_now` is local time (for calendar-day accounting).
#[derive(Debug, Clone)]
pub struct TickInput {
    pub mono_delta_secs: f64,
    pub wall_delta_secs: f64,
    pub wall_now: DateTime<Local>,
}

/// A finalized day's totals, emitted on rollover for the persistence layer (M5)
/// to flush before the accumulator resets.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalizedDay {
    pub date: NaiveDate,
    pub active_secs: f64,
    pub overtime_secs: f64,
    pub total_cents: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TickOutcome {
    pub today_cents: i64,
    pub session_cents: i64,
    pub per_second_cents: f64,
    pub is_overtime: bool,
    pub local_date: NaiveDate,
    pub rolled_over: bool,
    pub sleep_resumed: bool,
    /// Present only on the tick that crossed midnight: the day that just closed.
    pub finalized_day: Option<FinalizedDay>,
}

/// Advance the engine by one beat.
pub fn apply_tick(state: &mut EngineState, input: &TickInput) -> TickOutcome {
    let sleep_resumed = (input.wall_delta_secs - input.mono_delta_secs) > SLEEP_THRESHOLD_SECS;

    // Active time accrues only while Working. `SuspendUnawareInstant` already
    // excludes sleep, so a slept-through tick contributes ~0. Clamp to [0, wall].
    let active_inc = if state.status == Status::Working {
        input
            .mono_delta_secs
            .clamp(0.0, input.wall_delta_secs.max(0.0))
    } else {
        0.0
    };

    let new_date = input.wall_now.date_naive();
    let mut rolled_over = false;
    let mut finalized_day: Option<FinalizedDay> = None;

    if new_date != state.current_local_date {
        rolled_over = true;
        let (pre, post) = split_for_midnight(state.current_local_date, new_date, input, active_inc);

        // finalize the day that just closed (old accumulator + the pre-midnight slice)
        let old_final = state.accumulated_active_secs + pre;
        finalized_day = Some(FinalizedDay {
            date: state.current_local_date,
            active_secs: old_final,
            overtime_secs: (old_final - state.settings.daily_threshold_secs as f64).max(0.0),
            total_cents: rate::earnings_cents(
                old_final,
                state.settings.daily_threshold_secs,
                state.settings.rate_millicents_per_sec,
                state.settings.overtime_mult_x100,
            ),
        });

        // start the new day: threshold window resets, post-midnight slice carries over
        state.current_local_date = new_date;
        state.accumulated_active_secs = post;
        // session anchor follows the day (sessionCents reflects the new day's slice)
        state.session_anchor_active_secs = 0.0;
    } else {
        state.accumulated_active_secs += active_inc;
    }

    TickOutcome {
        today_cents: state.today_cents(),
        session_cents: state.session_cents(),
        per_second_cents: state.per_second_cents(),
        is_overtime: state.is_overtime(),
        local_date: state.current_local_date,
        rolled_over,
        sleep_resumed,
        finalized_day,
    }
}

/// Compute the pre/post-midnight active split for a rollover tick.
fn split_for_midnight(
    old_date: NaiveDate,
    new_date: NaiveDate,
    input: &TickInput,
    active_inc: f64,
) -> (f64, f64) {
    let prev_wall =
        input.wall_now - Duration::milliseconds((input.wall_delta_secs * 1000.0) as i64);
    // boundary = start of the new local day
    match rollover::midnight_local(new_date) {
        Some(midnight) => {
            let pre_wall_secs = (midnight - prev_wall).num_milliseconds() as f64 / 1000.0;
            rollover::split_active(active_inc, input.wall_delta_secs, pre_wall_secs)
        }
        // tz resolution failed (shouldn't happen) — attribute all to the new day
        None => {
            let _ = old_date;
            (0.0, active_inc.max(0.0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::rollover::midnight_local;
    use crate::engine::state::EngineSettings;

    fn settings() -> EngineSettings {
        // 1 cent/s, T = 100s, 2× overtime
        EngineSettings {
            rate_millicents_per_sec: 1000,
            daily_threshold_secs: 100,
            overtime_mult_x100: 200,
        }
    }

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 6, 27).unwrap()
    }

    /// A wall time safely mid-day (noon) so "no rollover" tests never straddle
    /// midnight regardless of host tz.
    fn noon() -> DateTime<Local> {
        midnight_local(day()).unwrap() + Duration::hours(12)
    }

    fn working_state() -> EngineState {
        let mut s = EngineState::new(settings(), day());
        s.start("sess".into());
        s
    }

    #[test]
    fn working_accumulates_one_second() {
        let mut s = working_state();
        let out = apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 1.0,
                wall_delta_secs: 1.0,
                wall_now: noon(),
            },
        );
        assert!((s.accumulated_active_secs - 1.0).abs() < 1e-9);
        assert_eq!(out.today_cents, 1);
        assert!(!out.rolled_over);
        assert!(!out.sleep_resumed);
        assert!(out.finalized_day.is_none());
    }

    #[test]
    fn paused_does_not_accumulate() {
        let mut s = working_state();
        s.pause();
        apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 1.0,
                wall_delta_secs: 1.0,
                wall_now: noon(),
            },
        );
        assert_eq!(s.accumulated_active_secs, 0.0);
    }

    #[test]
    fn idle_does_not_accumulate() {
        let mut s = EngineState::new(settings(), day()); // idle
        apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 1.0,
                wall_delta_secs: 1.0,
                wall_now: noon(),
            },
        );
        assert_eq!(s.accumulated_active_secs, 0.0);
    }

    #[test]
    fn sleep_two_hours_counts_zero_and_flags_resume() {
        // Working, but SuspendUnawareInstant reports ~0 active while 7200s of wall
        // time passed (machine asleep). Active must not grow; flag must trip.
        let mut s = working_state();
        let out = apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 0.0,
                wall_delta_secs: 7200.0,
                wall_now: noon(),
            },
        );
        assert_eq!(s.accumulated_active_secs, 0.0);
        assert_eq!(out.today_cents, 0);
        assert!(out.sleep_resumed);
    }

    #[test]
    fn overtime_kicks_in_past_threshold() {
        let mut s = working_state();
        s.accumulated_active_secs = 99.0; // just under T=100
        let out = apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 2.0,
                wall_delta_secs: 2.0,
                wall_now: noon(),
            },
        );
        // now 101s: 100 regular (100c) + 1 overtime @2× (2c) = 102
        assert!((s.accumulated_active_secs - 101.0).abs() < 1e-9);
        assert_eq!(out.today_cents, 102);
        assert!(out.is_overtime);
        assert!((out.per_second_cents - 2.0).abs() < 1e-9); // 1c base × 2
    }

    #[test]
    fn rollover_splits_active_and_resets_threshold() {
        // A tick straddling midnight: 4s wall, fully active, 1s before / 3s after.
        let mut s = working_state();
        s.accumulated_active_secs = 90.0; // worked 90s on the old day
        let new_date = day().succ_opt().unwrap();
        // wall_now = 3s into the new day → prev_wall = 1s before midnight
        let wall_now = midnight_local(new_date).unwrap() + Duration::seconds(3);
        let out = apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 4.0,
                wall_delta_secs: 4.0,
                wall_now,
            },
        );
        assert!(out.rolled_over);
        assert_eq!(out.local_date, new_date);
        assert_eq!(s.current_local_date, new_date);

        // old day finalized at 90 + 1 = 91s
        let fin = out
            .finalized_day
            .expect("rollover must finalize the old day");
        assert_eq!(fin.date, day());
        assert!((fin.active_secs - 91.0).abs() < 1e-6);
        assert_eq!(fin.total_cents, 91);

        // new day carries the 3s post-midnight slice; threshold reset
        assert!((s.accumulated_active_secs - 3.0).abs() < 1e-6);
        assert_eq!(out.today_cents, 3);
        assert_eq!(s.session_anchor_active_secs, 0.0);
        assert!(!out.is_overtime);
    }

    #[test]
    fn rollover_while_idle_finalizes_zero_new_slice() {
        let mut s = EngineState::new(settings(), day());
        s.accumulated_active_secs = 50.0; // earned earlier, then clocked out
        let new_date = day().succ_opt().unwrap();
        let wall_now = midnight_local(new_date).unwrap() + Duration::seconds(2);
        let out = apply_tick(
            &mut s,
            &TickInput {
                mono_delta_secs: 2.0,
                wall_delta_secs: 2.0,
                wall_now,
            },
        );
        assert!(out.rolled_over);
        let fin = out.finalized_day.unwrap();
        assert!((fin.active_secs - 50.0).abs() < 1e-9); // idle → no pre slice added
        assert_eq!(s.accumulated_active_secs, 0.0); // new day starts empty
        assert_eq!(out.today_cents, 0);
    }
}
