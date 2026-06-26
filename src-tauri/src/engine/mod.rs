//! PayPulse earnings engine — the pure, OS-clock-free core (PLAN §1.1, §1.5).
//!
//! Wrapped by a single `Arc<Mutex<EngineState>>` in Tauri managed state and driven
//! by one `tokio::interval(1s)` task (M2). Everything here is deterministic and
//! property-tested; no `tauri`/webview imports.

pub mod rate;
pub mod rollover;
pub mod state;
pub mod tick;

pub use state::{EngineSettings, EngineState, Status};
// FinalizedDay / TickOutcome / SLEEP_THRESHOLD_SECS are consumed by M5 (persistence)
// and the live loop's internals; keep them re-exported as the engine's public surface.
#[allow(unused_imports)]
pub use tick::{apply_tick, FinalizedDay, TickInput, TickOutcome, SLEEP_THRESHOLD_SECS};

#[cfg(test)]
mod proptests {
    use super::rate;
    use super::state::{EngineSettings, EngineState};
    use super::tick::{apply_tick, TickInput};
    use crate::engine::rollover::midnight_local;
    use chrono::{Duration, NaiveDate};
    use proptest::prelude::*;

    fn fixed_noon() -> chrono::DateTime<chrono::Local> {
        let d = NaiveDate::from_ymd_opt(2026, 6, 27).unwrap();
        midnight_local(d).unwrap() + Duration::hours(12)
    }

    proptest! {
        /// Earnings never decrease as active time grows (fixed settings).
        #[test]
        fn earnings_monotonic_in_time(
            rate_mc in 0u64..10_000,
            thr in 0u64..100_000,
            mult in 100u64..400,
            a in 0.0f64..200_000.0,
            b in 0.0f64..200_000.0,
        ) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            let e_lo = rate::earnings_cents(lo, thr, rate_mc, mult);
            let e_hi = rate::earnings_cents(hi, thr, rate_mc, mult);
            prop_assert!(e_hi >= e_lo, "earnings dropped: {e_lo} -> {e_hi}");
        }

        /// Summing per-second marginal increments equals the closed-form total —
        /// i.e. recomputing today from the accumulator introduces no display drift.
        #[test]
        fn marginal_increments_equal_total(
            rate_mc in 1u64..5_000,
            thr in 0u64..3_000,
            mult in 100u64..300,
            secs in 1u64..6_000,
        ) {
            let total = rate::earnings_cents(secs as f64, thr, rate_mc, mult);
            let mut sum = 0i64;
            let mut prev = 0i64;
            for s in 1..=secs {
                let now = rate::earnings_cents(s as f64, thr, rate_mc, mult);
                sum += now - prev;
                prev = now;
            }
            prop_assert_eq!(sum, total);
        }

        /// Closed-form math saturates on extreme / negative inputs — never panics.
        #[test]
        fn earnings_never_panics(
            rate_mc in 0u64..(u32::MAX as u64),
            thr in 0u64..1_000_000,
            mult in 0u64..1_000,
            a in -1.0e6f64..1.0e9,
        ) {
            let _ = rate::earnings_cents(a, thr, rate_mc, mult);
            let _ = rate::is_overtime(a, thr);
            let _ = rate::per_second_cents(a, thr, rate_mc, mult);
        }

        /// apply_tick tolerates garbage deltas (negative, huge) without panicking,
        /// and the accumulator stays non-negative.
        #[test]
        fn tick_never_panics_and_accumulator_nonnegative(
            mono in -10.0f64..1.0e6,
            wall in -10.0f64..1.0e6,
        ) {
            let mut s = EngineState::new(EngineSettings::default(), NaiveDate::from_ymd_opt(2026, 6, 27).unwrap());
            s.start("p".into());
            let input = TickInput { mono_delta_secs: mono, wall_delta_secs: wall, wall_now: fixed_noon() };
            let _ = apply_tick(&mut s, &input);
            prop_assert!(s.accumulated_active_secs >= 0.0);
        }
    }
}
