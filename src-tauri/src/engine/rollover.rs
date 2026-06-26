//! Midnight rollover helpers (PLAN §1.5: "午夜拆分"). Because overtime is reckoned
//! per local calendar day, a tick that straddles midnight must attribute its active
//! seconds proportionally to the old/new day, and the new day's threshold window
//! resets. The pure split is OS-clock-free and unit-testable; the local-midnight
//! timestamp is the only chrono-dependent piece.

use chrono::{DateTime, Local, LocalResult, NaiveDate, TimeZone};

/// Split a tick's active increment across a single midnight boundary.
///
/// `pre_wall_secs` = how many of this tick's `wall_delta_secs` fell on the OLD day.
/// Returns `(pre, post)` active seconds. Active time is split by the same fraction
/// as wall time (a 1 Hz tick straddles by < 1 s, so this is sub-second in practice;
/// the proportional split keeps property tests exact regardless of delta size).
pub fn split_active(active_inc: f64, wall_delta_secs: f64, pre_wall_secs: f64) -> (f64, f64) {
    let active = active_inc.max(0.0);
    if active <= 0.0 || wall_delta_secs <= 0.0 {
        return (0.0, active);
    }
    let frac = (pre_wall_secs / wall_delta_secs).clamp(0.0, 1.0);
    let pre = active * frac;
    (pre, active - pre)
}

/// Start-of-day (00:00) in the local timezone for `date`, handling the rare DST
/// gap at midnight by nudging to 01:00 (saturating, never panicking).
pub fn midnight_local(date: NaiveDate) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt, _) => Some(dt),
        LocalResult::None => {
            let naive2 = date.and_hms_opt(1, 0, 0)?;
            Local.from_local_datetime(&naive2).single()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_all_before_midnight() {
        // entire tick on the old day
        let (pre, post) = split_active(1.0, 1.0, 1.0);
        assert!((pre - 1.0).abs() < 1e-9);
        assert!(post.abs() < 1e-9);
    }

    #[test]
    fn split_all_after_midnight() {
        let (pre, post) = split_active(1.0, 1.0, 0.0);
        assert!(pre.abs() < 1e-9);
        assert!((post - 1.0).abs() < 1e-9);
    }

    #[test]
    fn split_half_and_half() {
        let (pre, post) = split_active(2.0, 2.0, 1.0);
        assert!((pre - 1.0).abs() < 1e-9);
        assert!((post - 1.0).abs() < 1e-9);
    }

    #[test]
    fn split_conserves_total() {
        let (pre, post) = split_active(0.8, 1.3, 0.4);
        assert!((pre + post - 0.8).abs() < 1e-9);
    }

    #[test]
    fn split_clamps_out_of_range_pre() {
        // pre_wall > wall_delta → clamp to all-pre
        let (pre, post) = split_active(1.0, 1.0, 5.0);
        assert!((pre - 1.0).abs() < 1e-9);
        assert!(post.abs() < 1e-9);
    }

    #[test]
    fn split_zero_active() {
        let (pre, post) = split_active(0.0, 1.0, 0.5);
        assert_eq!(pre, 0.0);
        assert_eq!(post, 0.0);
    }

    #[test]
    fn midnight_local_resolves() {
        let d = NaiveDate::from_ymd_opt(2026, 6, 27).unwrap();
        let m = midnight_local(d).unwrap();
        // whatever the host tz, it must be the 27th at 00:00 (or DST-nudged 01:00) local
        use chrono::Timelike;
        assert_eq!(m.date_naive(), d);
        assert!(m.hour() == 0 || m.hour() == 1);
        assert_eq!(m.minute(), 0);
    }
}
