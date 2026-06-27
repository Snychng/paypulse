//! The single 1 Hz live loop (PLAN §1.1, §1.5, §2-M2). Measures active time with
//! `SuspendUnawareInstant` (sleep-unaware) and real elapsed time with the local
//! wall clock (sleep-aware, for sleep detection + calendar-day accounting), applies
//! one engine tick, then emits `paypulse://tick` to every window and refreshes the
//! tray per-OS.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::AppState;
use crate::engine::{apply_tick, Status};
use crate::ipc::{
    ChangeReason, MilestonePayload, StateChangedPayload, TickPayload, EVENT_MILESTONE,
    EVENT_STATE_CHANGED, EVENT_TICK,
};
use crate::persistence;

/// Flush today's totals + checkpoint this often while working (PLAN §1.2: never
/// every tick — tiered flush to avoid write amplification).
const FLUSH_EVERY_SECS: u32 = 15;

pub fn spawn_engine_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut secs_since_flush = 0u32;

        loop {
            interval.tick().await;

            let state = app.state::<AppState>();
            #[allow(clippy::type_complexity)]
            let (
                tick_payload,
                state_change,
                today_cents,
                status,
                finalized,
                accumulated,
                threshold,
                date,
            ) = {
                let mut clock = state.clock.lock().await;
                let input = clock.next_tick_input();
                let mut eng = state.engine.lock().await;
                let out = apply_tick(&mut eng, &input);

                let payload = TickPayload {
                    today_cents: out.today_cents,
                    session_cents: out.session_cents,
                    session_active_secs: eng.session_active_secs(),
                    per_second_cents: out.per_second_cents,
                    state: eng.status,
                    is_overtime: out.is_overtime,
                    local_date: out.local_date.to_string(),
                    session_id: eng.session_id.clone(),
                    milestone_hit: false, // milestone emission lands in M6
                };

                // Surface rollover / sleep-resume as a state-changed with a reason.
                let sc = if out.rolled_over || out.sleep_resumed {
                    let reason = if out.rolled_over {
                        ChangeReason::Rollover
                    } else {
                        ChangeReason::SleepResume
                    };
                    Some(StateChangedPayload {
                        state: eng.status,
                        session_id: eng.session_id.clone(),
                        reason,
                        today_cents: out.today_cents,
                        session_active_secs: eng.session_active_secs(),
                        local_date: out.local_date.to_string(),
                    })
                } else {
                    None
                };

                (
                    payload,
                    sc,
                    out.today_cents,
                    eng.status,
                    out.finalized_day,
                    eng.accumulated_active_secs,
                    eng.settings.daily_threshold_secs,
                    eng.current_local_date,
                )
            };

            let _ = app.emit(EVENT_TICK, &tick_payload);
            if let Some(sc) = state_change {
                let _ = app.emit(EVENT_STATE_CHANGED, &sc);
            }
            update_tray(&app, status, today_cents);

            // --- persistence (M5): tiered flush, never every tick ---
            // 1) a rollover finalizes the day that just closed + resets milestones
            if let Some(fin) = finalized {
                let _ = persistence::upsert_day_total(
                    &state.db,
                    fin.date,
                    fin.total_cents,
                    fin.active_secs as i64,
                    fin.overtime_secs as i64,
                )
                .await;
                *state.last_milestone_cents.lock().unwrap() = 0; // new day → milestones reset
            }

            // --- milestone (M6): fire once when today crosses a configured threshold ---
            if status == Status::Working {
                let (milestones, notify_on) = {
                    let s = state.settings.lock().await;
                    (s.milestones_cents.clone(), s.notifications_enabled)
                };
                if !milestones.is_empty() {
                    let hit = {
                        let last = state.last_milestone_cents.lock().unwrap();
                        milestones
                            .iter()
                            .copied()
                            .filter(|&m| m <= today_cents && m > *last)
                            .max()
                    };
                    if let Some(amount) = hit {
                        *state.last_milestone_cents.lock().unwrap() = amount;
                        let label = format!("¥{:.2}", amount as f64 / 100.0);
                        // JS side drives the celebration burst
                        let _ = app.emit(
                            EVENT_MILESTONE,
                            MilestonePayload {
                                kind: "daily".into(),
                                amount_cents: amount,
                                label: label.clone(),
                            },
                        );
                        // OS notification fired once from Rust (single source, gated)
                        if notify_on {
                            use tauri_plugin_notification::NotificationExt;
                            let _ = app
                                .notification()
                                .builder()
                                .title("PayPulse 薪跳")
                                .body(format!("🎉 今日已达成里程碑 {label}"))
                                .show();
                        }
                    }
                }
            }
            // 2) while working, checkpoint + flush today every FLUSH_EVERY_SECS
            if status == Status::Working {
                secs_since_flush += 1;
                if secs_since_flush >= FLUSH_EVERY_SECS {
                    secs_since_flush = 0;
                    let overtime_secs = (accumulated - threshold as f64).max(0.0) as i64;
                    let _ = persistence::upsert_day_total(
                        &state.db,
                        date,
                        today_cents,
                        accumulated as i64,
                        overtime_secs,
                    )
                    .await;
                    persistence::checkpoint::write(
                        &app,
                        &date.to_string(),
                        accumulated,
                        today_cents,
                    );
                }
            } else {
                secs_since_flush = 0;
            }
        }
    });
}

/// Per-OS tray refresh (PLAN §1.4). Runs on the main thread because macOS tray
/// (AppKit) mutations must not happen off-thread.
fn update_tray(app: &AppHandle, status: Status, today_cents: i64) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let tray = match app.tray_by_id("main") {
            Some(t) => t,
            None => return,
        };
        let money = format!("¥{:.2}", today_cents as f64 / 100.0);

        #[cfg(target_os = "macos")]
        {
            // gate by integer-cent change so we only redraw on a real change
            let st = app.state::<AppState>();
            let mut last = st.last_tray_cents.lock().unwrap();
            if *last != today_cents {
                let _ = tray.set_title(Some(money));
                *last = today_cents;
            }
            let _ = status;
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Windows tray has no title text → tooltip carries the live figure.
            let label = match status {
                Status::Working => "工作中",
                Status::Paused => "摸鱼中",
                Status::Idle => "待机",
            };
            let _ = tray.set_tooltip(Some(format!("PayPulse · {label} · {money}")));
        }
    });
}
