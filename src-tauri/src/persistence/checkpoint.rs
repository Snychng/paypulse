//! 15-second crash-recovery checkpoint (PLAN §1.2). The durable SQLite truth is
//! only flushed on pause/stop/rollover; this `store` checkpoint captures the live
//! accumulator in between so a crash loses at most ~15 s of un-flushed time. On
//! startup we restore the checkpoint (conservative: discard anything newer).

use serde_json::json;
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "counter.json";
const KEY: &str = "checkpoint";

/// Persist the live accumulator for the current local day.
pub fn write(
    app: &AppHandle<Wry>,
    local_date: &str,
    accumulated_active_secs: f64,
    today_cents: i64,
) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(
            KEY,
            json!({
                "localDate": local_date,
                "accumulatedActiveSecs": accumulated_active_secs,
                "todayCents": today_cents,
            }),
        );
        let _ = store.save();
    }
}

/// Read the checkpoint as `(local_date, accumulated_active_secs)` if present.
pub fn read(app: &AppHandle<Wry>) -> Option<(String, f64)> {
    let store = app.store(STORE_FILE).ok()?;
    let v = store.get(KEY)?;
    let date = v.get("localDate")?.as_str()?.to_string();
    let secs = v.get("accumulatedActiveSecs")?.as_f64()?;
    Some((date, secs))
}
