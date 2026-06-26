//! Rust-authoritative persistence (PLAN §1.2, §5). SQLite via `sqlx` is the durable
//! truth; the engine loop writes it directly (tiered flush — never every tick). The
//! 15 s `store` checkpoint (see `checkpoint`) covers the un-flushed tail for crash
//! recovery. Schema is created idempotently (`IF NOT EXISTS`) at startup.

pub mod checkpoint;

use std::path::Path;

use chrono::{Duration, Local, NaiveDate};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::ipc::{DayTotal, SettingsDto, StatsRange, StatsResult};

/// Open (creating if missing) the SQLite pool and apply the idempotent schema.
pub async fn init(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;

    // raw_sql runs the multi-statement schema files as one batch.
    sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
        .execute(&pool)
        .await?;
    sqlx::raw_sql(include_str!("../../migrations/0002_indexes.sql"))
        .execute(&pool)
        .await?;
    Ok(pool)
}

// ---- settings ----

pub async fn load_settings(pool: &SqlitePool) -> Result<SettingsDto, sqlx::Error> {
    let row = sqlx::query(
        "SELECT monthly_salary_cents, daily_hours, workdays_per_month, overtime_multiplier_x100, \
         milestones_cents, theme, language, currency, notifications_enabled, autostart_enabled, \
         windows_icon_number, transparency_enabled, mini_opacity_x100, display_decimals \
         FROM settings WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    Ok(SettingsDto {
        monthly_salary_cents: row.get::<i64, _>("monthly_salary_cents") as u64,
        daily_hours: row.get::<f64, _>("daily_hours"),
        workdays_per_month: row.get::<i64, _>("workdays_per_month") as u64,
        overtime_multiplier_x100: row.get::<i64, _>("overtime_multiplier_x100") as u64,
        milestones_cents: serde_json::from_str(&row.get::<String, _>("milestones_cents"))
            .unwrap_or_default(),
        theme: row.get("theme"),
        language: row.get("language"),
        currency: row.get("currency"),
        notifications_enabled: row.get::<i64, _>("notifications_enabled") != 0,
        autostart_enabled: row.get::<i64, _>("autostart_enabled") != 0,
        windows_icon_number: row.get::<i64, _>("windows_icon_number") != 0,
        transparency_enabled: row.get::<i64, _>("transparency_enabled") != 0,
        mini_opacity_x100: row.get::<i64, _>("mini_opacity_x100") as u64,
        display_decimals: row.get::<i64, _>("display_decimals") as u8,
    })
}

pub async fn save_settings(pool: &SqlitePool, s: &SettingsDto) -> Result<(), sqlx::Error> {
    let milestones = serde_json::to_string(&s.milestones_cents).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        "UPDATE settings SET monthly_salary_cents=?, daily_hours=?, workdays_per_month=?, \
         overtime_multiplier_x100=?, milestones_cents=?, theme=?, language=?, currency=?, \
         notifications_enabled=?, autostart_enabled=?, windows_icon_number=?, \
         transparency_enabled=?, mini_opacity_x100=?, display_decimals=? WHERE id=1",
    )
    .bind(s.monthly_salary_cents as i64)
    .bind(s.daily_hours)
    .bind(s.workdays_per_month as i64)
    .bind(s.overtime_multiplier_x100 as i64)
    .bind(milestones)
    .bind(&s.theme)
    .bind(&s.language)
    .bind(&s.currency)
    .bind(s.notifications_enabled as i64)
    .bind(s.autostart_enabled as i64)
    .bind(s.windows_icon_number as i64)
    .bind(s.transparency_enabled as i64)
    .bind(s.mini_opacity_x100 as i64)
    .bind(s.display_decimals as i64)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- day totals (the per-day flushed truth) ----

pub async fn upsert_day_total(
    pool: &SqlitePool,
    date: NaiveDate,
    total_cents: i64,
    active_secs: i64,
    overtime_secs: i64,
) -> Result<(), sqlx::Error> {
    let now = Local::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO day_totals(local_date, total_cents, active_secs, overtime_secs, updated_wall) \
         VALUES(?, ?, ?, ?, ?) \
         ON CONFLICT(local_date) DO UPDATE SET \
           total_cents=excluded.total_cents, active_secs=excluded.active_secs, \
           overtime_secs=excluded.overtime_secs, updated_wall=excluded.updated_wall",
    )
    .bind(date.to_string())
    .bind(total_cents)
    .bind(active_secs)
    .bind(overtime_secs)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Today's flushed `(total_cents, active_secs)` if a row exists (startup recovery).
pub async fn load_day_total(
    pool: &SqlitePool,
    date: NaiveDate,
) -> Result<Option<(i64, i64)>, sqlx::Error> {
    let row = sqlx::query("SELECT total_cents, active_secs FROM day_totals WHERE local_date = ?")
        .bind(date.to_string())
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| {
        (
            r.get::<i64, _>("total_cents"),
            r.get::<i64, _>("active_secs"),
        )
    }))
}

// ---- sessions (historical detail) ----

#[allow(clippy::too_many_arguments)]
pub async fn insert_session(
    pool: &SqlitePool,
    id: &str,
    start_wall: &str,
    end_wall: &str,
    local_date: NaiveDate,
    active_secs: i64,
    regular_secs: i64,
    overtime_secs: i64,
    earnings_cents: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sessions(id, start_wall, end_wall, local_date, active_secs, regular_secs, \
         overtime_secs, earnings_cents) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(start_wall)
    .bind(end_wall)
    .bind(local_date.to_string())
    .bind(active_secs)
    .bind(regular_secs)
    .bind(overtime_secs)
    .bind(earnings_cents)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- stats ----

/// Aggregate day_totals over a rolling window (PLAN D7: week = last 7 local days,
/// month = last 30; today = just today).
pub async fn get_stats(
    pool: &SqlitePool,
    range: StatsRange,
    today: NaiveDate,
) -> Result<StatsResult, sqlx::Error> {
    let (start, label) = match range {
        StatsRange::Today => (today, "today"),
        StatsRange::Week => (today - Duration::days(6), "week"),
        StatsRange::Month => (today - Duration::days(29), "month"),
    };

    let rows = sqlx::query(
        "SELECT local_date, total_cents, active_secs, overtime_secs FROM day_totals \
         WHERE local_date >= ? AND local_date <= ? ORDER BY local_date",
    )
    .bind(start.to_string())
    .bind(today.to_string())
    .fetch_all(pool)
    .await?;

    let mut days = Vec::with_capacity(rows.len());
    let mut total_cents = 0i64;
    for r in rows {
        let tc: i64 = r.get("total_cents");
        total_cents += tc;
        days.push(DayTotal {
            local_date: r.get("local_date"),
            total_cents: tc,
            active_secs: r.get("active_secs"),
            overtime_secs: r.get("overtime_secs"),
        });
    }

    Ok(StatsResult {
        range: label.into(),
        days,
        total_cents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_pool() -> SqlitePool {
        // shared in-memory DB for the test
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0002_indexes.sql"))
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn settings_roundtrip_and_default_seed() {
        let pool = mem_pool().await;
        // the init migration seeds a default row
        let mut s = load_settings(&pool).await.unwrap();
        assert_eq!(s.display_decimals, 3);
        assert_eq!(s.workdays_per_month, 22);

        s.monthly_salary_cents = 1_000_000;
        s.daily_hours = 7.5;
        s.milestones_cents = vec![10000, 20000];
        s.theme = "dark".into();
        save_settings(&pool, &s).await.unwrap();

        let r = load_settings(&pool).await.unwrap();
        assert_eq!(r.monthly_salary_cents, 1_000_000);
        assert!((r.daily_hours - 7.5).abs() < 1e-9);
        assert_eq!(r.milestones_cents, vec![10000, 20000]);
        assert_eq!(r.theme, "dark");
    }

    #[tokio::test]
    async fn day_total_upsert_and_stats() {
        let pool = mem_pool().await;
        let d = NaiveDate::from_ymd_opt(2026, 6, 27).unwrap();
        upsert_day_total(&pool, d, 1000, 3600, 0).await.unwrap();
        // upsert overwrites, not duplicates
        upsert_day_total(&pool, d, 2000, 7200, 100).await.unwrap();
        assert_eq!(load_day_total(&pool, d).await.unwrap(), Some((2000, 7200)));

        let prev = d - Duration::days(1);
        upsert_day_total(&pool, prev, 500, 1800, 0).await.unwrap();

        let week = get_stats(&pool, StatsRange::Week, d).await.unwrap();
        assert_eq!(week.total_cents, 2500); // 2000 today + 500 yesterday
        assert_eq!(week.days.len(), 2);

        let today = get_stats(&pool, StatsRange::Today, d).await.unwrap();
        assert_eq!(today.total_cents, 2000);
        assert_eq!(today.days.len(), 1);
    }
}
