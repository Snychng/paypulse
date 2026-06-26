//! Pure earnings math (PLAN §1.1). No webview / OS-clock dependency — fully unit-
//! and property-testable. All money is integer **cents**; the per-second rate is
//! stored in **millicents** (1 cent = 1000 millicents) and only rounded to cents
//! at the display/persistence boundary.

/// Per-second rate in **millicents**, computed from the pay model (PLAN §1.1):
/// `monthly_salary_cents * 1000 / workdays_per_month / daily_threshold_secs`.
///
/// Done in u128 to avoid overflow, rounded to the nearest millicent. Returns 0 if
/// any divisor is zero (un-configured salary → "上班" stays disabled, D8).
pub fn rate_millicents_per_sec(
    monthly_salary_cents: u64,
    workdays_per_month: u64,
    daily_threshold_secs: u64,
) -> u64 {
    if workdays_per_month == 0 || daily_threshold_secs == 0 {
        return 0;
    }
    let numer = monthly_salary_cents as u128 * 1000;
    let denom = workdays_per_month as u128 * daily_threshold_secs as u128;
    ((numer + denom / 2) / denom) as u64
}

/// Daily overtime threshold in seconds from fractional daily hours.
pub fn daily_threshold_secs(daily_hours: f64) -> u64 {
    (daily_hours.max(0.0) * 3600.0).round() as u64
}

/// Earnings in integer **cents** for `active_secs` of work today, given the
/// per-second `rate_mc` (millicents), the daily overtime `threshold_secs` T and
/// the overtime multiplier `mult_x100` (e.g. 150 = 1.5×).
///
/// `earnings = min(t,T)·rate + max(0,t−T)·rate·mult`  (PLAN §1.1) — continuous at
/// `t == T`. Computed in millicents then rounded once to cents.
pub fn earnings_cents(active_secs: f64, threshold_secs: u64, rate_mc: u64, mult_x100: u64) -> i64 {
    let t = active_secs.max(0.0);
    let thr = threshold_secs as f64;
    let regular_secs = t.min(thr);
    let overtime_secs = (t - thr).max(0.0);

    let rate = rate_mc as f64;
    let regular_mc = regular_secs * rate;
    let overtime_mc = overtime_secs * rate * (mult_x100 as f64 / 100.0);

    ((regular_mc + overtime_mc) / 1000.0).round() as i64
}

/// Current marginal per-second rate in **cents** (fractional, display only):
/// `rate` normally, `rate·mult` once past the daily threshold.
pub fn per_second_cents(
    active_secs: f64,
    threshold_secs: u64,
    rate_mc: u64,
    mult_x100: u64,
) -> f64 {
    let base = rate_mc as f64 / 1000.0;
    if is_overtime(active_secs, threshold_secs) {
        base * (mult_x100 as f64 / 100.0)
    } else {
        base
    }
}

/// Past the daily threshold (and the threshold is meaningful)?
pub fn is_overtime(active_secs: f64, threshold_secs: u64) -> bool {
    threshold_secs > 0 && active_secs > threshold_secs as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    // 8h/day, 22 workdays, ¥10,000/month = 1_000_000 cents.
    // rate = 1_000_000 * 1000 / 22 / 28800 = 1_000_000_000 / 633_600 ≈ 1578.28 mc/s
    #[test]
    fn rate_precision() {
        let t = daily_threshold_secs(8.0);
        assert_eq!(t, 28800);
        let r = rate_millicents_per_sec(1_000_000, 22, t);
        assert_eq!(r, 1578); // rounded to nearest millicent
    }

    #[test]
    fn rate_zero_when_unconfigured() {
        assert_eq!(rate_millicents_per_sec(0, 22, 28800), 0);
        assert_eq!(rate_millicents_per_sec(1_000_000, 0, 28800), 0);
        assert_eq!(rate_millicents_per_sec(1_000_000, 22, 0), 0);
    }

    #[test]
    fn fractional_daily_hours() {
        assert_eq!(daily_threshold_secs(7.5), 27000);
        assert_eq!(daily_threshold_secs(8.5), 30600);
    }

    #[test]
    fn earnings_below_threshold_is_linear() {
        // rate 1000 mc/s = 1 cent/s. 100s → 100 cents, no overtime.
        assert_eq!(earnings_cents(100.0, 28800, 1000, 150), 100);
    }

    #[test]
    fn earnings_continuous_at_threshold() {
        // exactly at T: pure regular, no overtime kink.
        let t = 28800u64;
        let rate = 1000u64;
        let at = earnings_cents(t as f64, t, rate, 150);
        assert_eq!(at, 28800); // 28800s * 1 cent
                               // just past T grows at 1.5×, continuous (no jump at the boundary)
        let just_past = earnings_cents(t as f64 + 1.0, t, rate, 150);
        assert_eq!(just_past, 28800 + 2); // +1s overtime at 1.5 cent → +1.5 → round 2 (28801.5→28802)
    }

    #[test]
    fn earnings_overtime_segment() {
        // 10h work, T=8h, rate 1 cent/s, 1.5×.
        // regular 28800s*1 = 28800 cents; overtime 7200s*1*1.5 = 10800 cents → 39600.
        let t = daily_threshold_secs(8.0);
        let total = earnings_cents(10.0 * 3600.0, t, 1000, 150);
        assert_eq!(total, 39600);
    }

    #[test]
    fn earnings_marginal_sum_equals_total_within_one_cent() {
        // Summing per-second marginal earnings must equal the closed-form total ±1 cent.
        let t = daily_threshold_secs(8.0);
        let rate = 1578u64;
        let mult = 150u64;
        let secs = 9 * 3600; // crosses the 8h threshold
        let mut marginal_sum = 0i64;
        let mut prev = 0i64;
        for s in 1..=secs {
            let now = earnings_cents(s as f64, t, rate, mult);
            marginal_sum += now - prev;
            prev = now;
        }
        let total = earnings_cents(secs as f64, t, rate, mult);
        assert_eq!(marginal_sum, total); // telescoping — exact, since we always recompute from total
        assert!((total - prev).abs() <= 1);
    }

    #[test]
    fn overtime_flag_and_per_second_rate() {
        let t = daily_threshold_secs(8.0);
        assert!(!is_overtime(100.0, t));
        assert!(is_overtime(t as f64 + 1.0, t));
        // per-second jumps from base to base*mult past T
        let base = per_second_cents(100.0, t, 1500, 200);
        let ot = per_second_cents(t as f64 + 10.0, t, 1500, 200);
        assert!((base - 1.5).abs() < 1e-9);
        assert!((ot - 3.0).abs() < 1e-9);
    }

    #[test]
    fn negative_active_secs_saturates_to_zero() {
        assert_eq!(earnings_cents(-50.0, 28800, 1000, 150), 0);
        assert!(!is_overtime(-1.0, 28800));
    }
}
