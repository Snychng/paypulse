//! PayPulse 薪跳 — Tauri backend entry.
//!
//! Wires the pure earnings engine (M1) to a single 1 Hz live loop + tray (M2),
//! builds the 3 auxiliary windows by label, keeps macOS menubar-resident, and
//! makes "X" hide (never quit) every window.

mod app_state;
mod clock;
mod commands;
mod engine;
mod ipc;
mod persistence;
mod tray;

use std::path::PathBuf;

use chrono::Local;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use app_state::AppState;
use engine::EngineState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // --- plugins (PLAN §3) ---
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // sql plugin registered for potential JS reads; schema + writes are owned
        // by our sqlx pool (persistence.rs) so the engine stays Rust-authoritative.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // --- managed state: the single engine authority + in-memory settings (M5 persists) ---
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // open the durable store + recover today's progress (PLAN §1.2, M5)
            let db_path = app
                .path()
                .app_config_dir()
                .map(|d| d.join("paypulse.db"))
                .unwrap_or_else(|_| PathBuf::from("paypulse.db"));
            let pool = tauri::async_runtime::block_on(persistence::init(&db_path))
                .expect("failed to open paypulse.db");

            let settings = tauri::async_runtime::block_on(persistence::load_settings(&pool))
                .unwrap_or_default();

            let today = Local::now().date_naive();
            let today_str = today.to_string();

            // conservative recovery: prefer the 15 s checkpoint tail for today, else
            // the flushed day_total, else zero (PLAN §1.2 "只补到检查点、丢弃未 flush 尾").
            let recovered_secs = match persistence::checkpoint::read(app.handle()) {
                Some((date, secs)) if date == today_str => secs,
                _ => tauri::async_runtime::block_on(persistence::load_day_total(&pool, today))
                    .ok()
                    .flatten()
                    .map(|(_, active)| active as f64)
                    .unwrap_or(0.0),
            };

            let mut engine_state = EngineState::new(settings.to_engine_settings(), today);
            engine_state.accumulated_active_secs = recovered_secs;

            // don't re-fire today's already-passed milestones after a restart
            let recovered_today = engine_state.today_cents();
            let init_milestone = settings
                .milestones_cents
                .iter()
                .copied()
                .filter(|&m| m <= recovered_today)
                .max()
                .unwrap_or(0);

            app.manage(AppState::new(engine_state, settings, pool, init_milestone));

            // macOS: menubar-resident, no Dock icon (PLAN §1.3). Flips to Regular
            // when the settings window opens (M4).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_aux_windows(app.handle())?;
            tray::build_tray(app.handle())?;
            clock::spawn_engine_loop(app.handle().clone());

            // autostart `--minimized`: launch straight to the tray, no windows shown (M6)
            if std::env::args().any(|a| a == "--minimized") {
                for label in ["main", "mini"] {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // "X" never quits a tray-resident app — intercept close → hide (PLAN §1.3)
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                // macOS: drop back to menubar-only when the settings window closes (M6)
                #[cfg(target_os = "macos")]
                if window.label() == "settings" {
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
            // popover dismisses itself when it loses focus (click-outside UX)
            WindowEvent::Focused(false) if window.label() == "popover" => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_start,
            commands::engine_pause,
            commands::engine_resume,
            commands::engine_stop,
            commands::get_snapshot,
            commands::get_settings,
            commands::update_settings,
            commands::get_stats,
            commands::toggle_mini,
            commands::open_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Build the three auxiliary windows by label. `main` (dashboard) is declared in
/// tauri.conf.json; these three are created here so we control their flags.
fn build_aux_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    // settings — regular bordered window, hidden until opened on demand (M4)
    if app.get_webview_window("settings").is_none() {
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
            .title("PayPulse · 设置")
            .inner_size(560.0, 680.0)
            .min_inner_size(556.0, 560.0)
            .resizable(true)
            .visible(false)
            .build()?;
    }

    // popover — frameless tray dropdown, hidden until tray click (M2)
    if app.get_webview_window("popover").is_none() {
        WebviewWindowBuilder::new(app, "popover", WebviewUrl::App("popover.html".into()))
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .inner_size(264.0, 340.0)
            .visible(false)
            .build()?;
    }

    // mini — frameless, always-on-top, translucent floating number window (M3).
    // Shown at M0/M2 for verification; becomes visible(false) + tray-toggled in M3.
    if app.get_webview_window("mini").is_none() {
        WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("mini.html".into()))
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .shadow(true)
            .transparent(true)
            .inner_size(300.0, 74.0)
            .min_inner_size(170.0, 56.0)
            .visible(true)
            .build()?;
    }

    Ok(())
}
