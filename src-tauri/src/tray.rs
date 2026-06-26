//! Tray / menubar (PLAN §1.4, §2-M2). Left click → popover (positioner-anchored),
//! right click → menu. Per-OS live text is handled in clock.rs (mac set_title /
//! Windows set_tooltip); here we build the icon, menu and event wiring.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_positioner::{Position, WindowExt};

use crate::commands;

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let start_i = MenuItem::with_id(app, "start", "上班", true, None::<&str>)?;
    let pause_i = MenuItem::with_id(app, "pause", "摸鱼（暂停）", true, None::<&str>)?;
    let stop_i = MenuItem::with_id(app, "stop", "下班", true, None::<&str>)?;
    let mini_i = MenuItem::with_id(app, "mini", "打开小窗", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出 PayPulse", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &start_i,
            &pause_i,
            &stop_i,
            &sep1,
            &mini_i,
            &settings_i,
            &sep2,
            &quit_i,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            // positioner must see every tray event to cache the tray rectangle
            tauri_plugin_positioner::on_tray_event(app, &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(app);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "start" => spawn_action(app, commands::do_start),
        "pause" => spawn_action(app, commands::do_pause),
        "stop" => spawn_action(app, commands::do_stop),
        "mini" => {
            let _ = commands::show_mini(app);
        }
        "settings" => {
            let _ = commands::show_settings(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Run an async engine action (do_start/pause/stop) from the sync menu handler.
fn spawn_action<F, Fut>(app: &AppHandle, action: F)
where
    F: FnOnce(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = crate::ipc::Snapshot> + Send,
{
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = action(app).await;
    });
}

fn toggle_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("popover") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.move_window(Position::TrayBottomCenter);
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
