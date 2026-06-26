//! JS→Rust commands (PLAN §6) + the reusable core actions the tray menu shares.
//! By default Tauri allows all app commands to every window (no capability needed).
//!
//! Persistence (M5): pause/stop flush the day_total + checkpoint; stop also writes a
//! session row; update_settings mirrors to SQLite. DB I/O always happens **off** the
//! engine lock (capture values under lock, release, then await).

use chrono::Local;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use uuid::Uuid;

use crate::app_state::{AppState, SessionStart};
use crate::engine::EngineState;
use crate::ipc::{
    ChangeReason, SettingsDto, Snapshot, StateChangedPayload, StatsRange, StatsResult,
    EVENT_STATE_CHANGED,
};
use crate::persistence;

// ---- helpers ----

fn snapshot_of(e: &EngineState) -> Snapshot {
    Snapshot {
        today_cents: e.today_cents(),
        session_cents: e.session_cents(),
        per_second_cents: e.per_second_cents(),
        state: e.status,
        is_overtime: e.is_overtime(),
        local_date: e.current_local_date.to_string(),
        session_id: e.session_id.clone(),
    }
}

fn emit_state_changed(app: &AppHandle, e: &EngineState, reason: ChangeReason) {
    let payload = StateChangedPayload {
        state: e.status,
        session_id: e.session_id.clone(),
        reason,
        today_cents: e.today_cents(),
        local_date: e.current_local_date.to_string(),
    };
    let _ = app.emit(EVENT_STATE_CHANGED, payload);
}

/// Values captured under the engine lock that the persistence layer needs.
struct FlushSnapshot {
    date: chrono::NaiveDate,
    accumulated_secs: f64,
    today_cents: i64,
    threshold_secs: u64,
}

/// Flush today's totals to SQLite + write the crash checkpoint (off the engine lock).
async fn flush(app: &AppHandle, fs: &FlushSnapshot) {
    let state = app.state::<AppState>();
    let overtime_secs = (fs.accumulated_secs - fs.threshold_secs as f64).max(0.0) as i64;
    let _ = persistence::upsert_day_total(
        &state.db,
        fs.date,
        fs.today_cents,
        fs.accumulated_secs as i64,
        overtime_secs,
    )
    .await;
    persistence::checkpoint::write(
        app,
        &fs.date.to_string(),
        fs.accumulated_secs,
        fs.today_cents,
    );
}

// ---- core actions (shared by commands + tray menu) ----

pub async fn do_start(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let sid = Uuid::new_v4().to_string();

    let (snap, marker) = {
        let mut eng = state.engine.lock().await;
        let started = eng.start(sid.clone());
        let marker = if started {
            Some(SessionStart {
                id: sid,
                start_wall: Local::now().to_rfc3339(),
                start_accumulated_secs: eng.accumulated_active_secs,
                start_cents: eng.today_cents(),
            })
        } else {
            None
        };
        emit_state_changed(&app, &eng, ChangeReason::User);
        (snapshot_of(&eng), marker)
    };

    if let Some(m) = marker {
        *state.session_start.lock().unwrap() = Some(m);
    }
    snap
}

pub async fn do_pause(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (snap, fs) = {
        let mut eng = state.engine.lock().await;
        eng.pause();
        emit_state_changed(&app, &eng, ChangeReason::User);
        (
            snapshot_of(&eng),
            FlushSnapshot {
                date: eng.current_local_date,
                accumulated_secs: eng.accumulated_active_secs,
                today_cents: eng.today_cents(),
                threshold_secs: eng.settings.daily_threshold_secs,
            },
        )
    };
    flush(&app, &fs).await; // flush on pause (PLAN §1.2 tiered flush)
    snap
}

pub async fn do_resume(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let mut eng = state.engine.lock().await;
    eng.resume();
    let snap = snapshot_of(&eng);
    emit_state_changed(&app, &eng, ChangeReason::User);
    snap
}

pub async fn do_stop(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (snap, fs) = {
        let mut eng = state.engine.lock().await;
        let fs = FlushSnapshot {
            date: eng.current_local_date,
            accumulated_secs: eng.accumulated_active_secs,
            today_cents: eng.today_cents(),
            threshold_secs: eng.settings.daily_threshold_secs,
        };
        eng.stop();
        emit_state_changed(&app, &eng, ChangeReason::User);
        (snapshot_of(&eng), fs)
    };

    let marker = state.session_start.lock().unwrap().take();
    flush(&app, &fs).await;

    if let Some(m) = marker {
        let session_active = (fs.accumulated_secs - m.start_accumulated_secs).max(0.0) as i64;
        let session_earnings = (fs.today_cents - m.start_cents).max(0);
        // per-session overtime split is non-trivial (overtime is reckoned per day),
        // so the session row stores active+earnings; day_totals holds the exact split.
        let _ = persistence::insert_session(
            &state.db,
            &m.id,
            &m.start_wall,
            &Local::now().to_rfc3339(),
            fs.date,
            session_active,
            session_active,
            0,
            session_earnings,
        )
        .await;
    }
    snap
}

// ---- window helpers (shared by commands + tray menu) ----

pub fn show_mini(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("mini") {
        w.show()?;
        w.set_focus()?;
    }
    Ok(())
}

pub fn toggle_mini_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("mini") {
        if w.is_visible().unwrap_or(false) {
            w.hide()?;
        } else {
            w.show()?;
            w.set_focus()?;
        }
    }
    Ok(())
}

pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    // macOS: surface in the Dock while settings is open (reset to Accessory on close).
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("settings") {
        w.show()?;
        w.set_focus()?;
    }
    Ok(())
}

// ---- #[command] wrappers ----

#[tauri::command]
pub async fn engine_start(app: AppHandle) -> Result<Snapshot, String> {
    Ok(do_start(app).await)
}

#[tauri::command]
pub async fn engine_pause(app: AppHandle) -> Result<Snapshot, String> {
    Ok(do_pause(app).await)
}

#[tauri::command]
pub async fn engine_resume(app: AppHandle) -> Result<Snapshot, String> {
    Ok(do_resume(app).await)
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle) -> Result<Snapshot, String> {
    Ok(do_stop(app).await)
}

#[tauri::command]
pub async fn get_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    let state = app.state::<AppState>();
    let eng = state.engine.lock().await;
    Ok(snapshot_of(&eng))
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<SettingsDto, String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

/// Validate + recompute the engine rate/threshold, mirror to SQLite, broadcast.
/// Full zod validation is on the JS side; here we clamp the load-bearing invariants.
#[tauri::command]
pub async fn update_settings(app: AppHandle, settings: SettingsDto) -> Result<SettingsDto, String> {
    if settings.daily_hours <= 0.0 || settings.daily_hours > 24.0 {
        return Err("daily_hours must be in (0, 24]".into());
    }
    if settings.workdays_per_month == 0 || settings.workdays_per_month > 31 {
        return Err("workdays_per_month must be in [1, 31]".into());
    }
    if settings.overtime_multiplier_x100 < 100 {
        return Err("overtime multiplier must be >= 1.0x".into());
    }

    let state = app.state::<AppState>();
    let engine_settings = settings.to_engine_settings();

    let _ = persistence::save_settings(&state.db, &settings).await;

    // apply OS-level autostart (login item / LaunchAgent) to match the toggle
    let autolaunch = app.autolaunch();
    if settings.autostart_enabled {
        let _ = autolaunch.enable();
    } else {
        let _ = autolaunch.disable();
    }
    {
        let mut stored = state.settings.lock().await;
        *stored = settings.clone();
    }
    {
        let mut eng = state.engine.lock().await;
        eng.apply_settings(engine_settings);
        emit_state_changed(&app, &eng, ChangeReason::Settings);
    }
    Ok(settings)
}

#[tauri::command]
pub async fn get_stats(app: AppHandle, range: StatsRange) -> Result<StatsResult, String> {
    let state = app.state::<AppState>();
    let today = Local::now().date_naive();
    persistence::get_stats(&state.db, range, today)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_mini(app: AppHandle) -> Result<(), String> {
    toggle_mini_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings(&app).map_err(|e| e.to_string())
}
