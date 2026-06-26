import { useEffect, useState } from "react";
import { motion } from "motion/react";

/**
 * M0 placeholder shell — proves the multi-page pipeline, the @tauri-apps/api
 * bridge, and the motion@^12 import all compile and render in each webview.
 * Replaced by real per-window UIs in M3 (mini), M4 (main/settings) and the
 * popover work in M2.
 */
export function WindowShell({
  label,
  title,
  frameless = false,
}: {
  label: string;
  title: string;
  frameless?: boolean;
}) {
  const [tauriLabel, setTauriLabel] = useState<string>("(browser)");

  useEffect(() => {
    let alive = true;
    // Lazily probe the Tauri window so a plain-browser `vite preview` still renders.
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (alive) setTauriLabel(getCurrentWindow().label);
      })
      .catch(() => {
        /* not running inside a Tauri webview */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      style={{
        height: "100%",
        display: "grid",
        placeContent: "center",
        gap: "8px",
        textAlign: "center",
        padding: "16px",
        background: frameless ? "transparent" : undefined,
      }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.3 }}
        style={{
          fontFamily: "var(--font-seg)",
          fontSize: "28px",
          color: "var(--color-money)",
          letterSpacing: "1px",
        }}
      >
        {title}
      </motion.div>
      <div style={{ fontSize: "11px", color: "var(--color-s-steel)" }}>
        window label: <b style={{ color: "var(--color-accent)" }}>{label}</b>
        {" · "}tauri: <b style={{ color: "var(--color-gain)" }}>{tauriLabel}</b>
      </div>
      <div style={{ fontSize: "10px", color: "var(--color-s-slate)" }}>
        M0 scaffold — UI lands in M3 / M4 / M8
      </div>
    </div>
  );
}
