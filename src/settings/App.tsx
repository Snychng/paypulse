/* ============================================================
   settings/App.tsx — PayPulse 设置窗口 UI
   职责：用本地副本编辑 SettingsDto，做 zod 前端校验，调用 updateSettings 落库。
   约束：React 不持有金钱权威——所有变更经 Rust 引擎重算+持久化+广播。
   单位约定：金额输入「元」，落库前 ×100 转「分」；倍率展示「×倍」，存 x100。
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { platform, type Platform } from "@tauri-apps/plugin-os";

import { useSettings } from "@/hooks/useSettings";
import { useI18n } from "@/hooks/useI18n";
import { updateSettings } from "@/shared/ipc";
import { currencySymbol } from "@/shared/format";
import type { SettingsDto, Theme, Language } from "@/shared/types";

type SettingsPlatform = "macos" | "windows";
type SettingsSection = "pay-model" | "appearance" | "behavior" | "about";

const BUG_REPORT_URL =
  "https://github.com/Snychng/paypulse/issues?q=sort:updated-desc+is:issue+state:open+";
const REPOSITORY_URL = "https://github.com/Snychng/paypulse";

/* ---------- 表单本地草稿（字符串字段便于受控输入，提交时再解析/校验） ---------- */
interface Draft {
  salaryYuan: string; // 月薪（元，字符串便于编辑）
  dailyHours: string; // 日工时（小时，支持小数）
  workdaysPerMonth: string; // 月工作天数
  overtimeMultiplierX100: number; // 加班倍率×100（stepper 直接维护整数）
  milestonesYuan: string; // 里程碑（逗号分隔的「元」值）
  theme: Theme;
  language: Language;
  notificationsEnabled: boolean;
  autostartEnabled: boolean;
  displayDecimals: number; // 0–4
  miniOpacityX100: number; // 35–100
  transparencyEnabled: boolean;
}

const DEFAULT_DRAFT: Draft = {
  salaryYuan: "35000",
  dailyHours: "8",
  workdaysPerMonth: "22",
  overtimeMultiplierX100: 150,
  milestonesYuan: "100, 500, 1000",
  theme: "system",
  language: "system",
  notificationsEnabled: true,
  autostartEnabled: false,
  displayDecimals: 3,
  miniOpacityX100: 90,
  transparencyEnabled: true,
};

/* ---------- DTO → 草稿（展示时分→元、x100→倍） ---------- */
function toDraft(s: SettingsDto): Draft {
  return {
    salaryYuan: String(s.monthlySalaryCents / 100),
    dailyHours: String(s.dailyHours),
    workdaysPerMonth: String(s.workdaysPerMonth),
    overtimeMultiplierX100: s.overtimeMultiplierX100,
    milestonesYuan: s.milestonesCents.map((c) => c / 100).join(", "),
    theme: s.theme,
    language: s.language,
    notificationsEnabled: s.notificationsEnabled,
    autostartEnabled: s.autostartEnabled,
    displayDecimals: s.displayDecimals,
    miniOpacityX100: s.miniOpacityX100,
    transparencyEnabled: s.transparencyEnabled,
  };
}

/* ---------- 把逗号分隔的「元」串解析成「分」数组（去空、非法值原样交给校验拦截） ---------- */
function parseMilestonesYuan(raw: string): number[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Math.round(parseFloat(t) * 100));
}

function resolveSettingsPlatform(): SettingsPlatform {
  try {
    const current: Platform = platform();
    return current === "windows" ? "windows" : "macos";
  } catch {
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
      return "windows";
    }
    return "macos";
  }
}

/* ---------- zod 校验规则（对齐硬约束）
   校验信息存「i18n key」而非定稿文案——保存失败时由 t(key) 翻译，做到错误文案双语。 ---------- */
const draftSchema = z.object({
  // 月薪（元）>0
  salaryYuan: z
    .string()
    .refine((v) => Number.isFinite(parseFloat(v)) && parseFloat(v) > 0, "error.salaryPositive"),
  // 0 < 日工时 ≤ 24
  dailyHours: z
    .string()
    .refine((v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 && n <= 24;
    }, "error.dailyHoursRange"),
  // 0 < 月工作天数 ≤ 31
  workdaysPerMonth: z
    .string()
    .refine((v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 && n <= 31;
    }, "error.workdaysRange"),
  // 倍率×100 ≥ 100（即 ≥1.0×）
  overtimeMultiplierX100: z.number().int().min(100, "error.overtimeMin"),
  // 里程碑：每个解析后须为 >0 的整数分（允许为空数组）
  milestonesYuan: z.string().refine((v) => {
    const parts = v
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return parts.every((t) => {
      const n = parseFloat(t);
      return Number.isFinite(n) && n > 0;
    });
  }, "error.milestonesPositive"),
  // 0 ≤ 小数位 ≤ 4
  displayDecimals: z.number().int().min(0).max(4),
  // 35 ≤ 透明度 ≤ 100
  miniOpacityX100: z.number().int().min(35).max(100),
});

/* ---------- 通用：分段控件（seg） ---------- */
type IconName =
  | "settings"
  | "pay"
  | "appearance"
  | "behavior"
  | "check"
  | "close"
  | "minus"
  | "plus"
  | "monitor"
  | "moon"
  | "sun"
  | "sparkle"
  | "heart"
  | "globe"
  | "textZh"
  | "textEn"
  | "about";

function Icon(props: { name: IconName; size?: number; className?: string }): JSX.Element {
  const { name, size = 16, className } = props;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "settings" && (
        <>
          <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
          <path d="M18.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L13 2.5h-4l-.4 2.6A8 8 0 0 0 6 6.6l-2.4-1-2 3.4 2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5L9 21.5h4l.4-2.6a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5Z" />
        </>
      )}
      {name === "pay" && (
        <>
          <path d="M4 7.5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
          <path d="M4 7.5v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4" />
          <path d="M4 11.5v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4" />
        </>
      )}
      {name === "appearance" && (
        <>
          <path d="M12 3v3" />
          <path d="M12 18v3" />
          <path d="m4.9 4.9 2.1 2.1" />
          <path d="m17 17 2.1 2.1" />
          <path d="M3 12h3" />
          <path d="M18 12h3" />
          <path d="m4.9 19.1 2.1-2.1" />
          <path d="m17 7 2.1-2.1" />
          <circle cx="12" cy="12" r="4" />
        </>
      )}
      {name === "behavior" && (
        <>
          <path d="M5 12a7 7 0 0 1 12-5" />
          <path d="M17 3v4h-4" />
          <path d="M19 12a7 7 0 0 1-12 5" />
          <path d="M7 21v-4h4" />
        </>
      )}
      {name === "check" && <path d="m5 12.5 4 4L19 6.5" />}
      {name === "close" && (
        <>
          <path d="M6 6 18 18" />
          <path d="M18 6 6 18" />
        </>
      )}
      {name === "minus" && <path d="M5 12h14" />}
      {name === "plus" && (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      )}
      {name === "monitor" && (
        <>
          <rect x="4" y="5" width="16" height="11" rx="2" />
          <path d="M8 20h8" />
          <path d="M12 16v4" />
        </>
      )}
      {name === "moon" && <path d="M20 14.7A8 8 0 0 1 9.3 4a7 7 0 1 0 10.7 10.7Z" />}
      {name === "sun" && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.9 4.9 1.4 1.4" />
          <path d="m17.7 17.7 1.4 1.4" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m4.9 19.1 1.4-1.4" />
          <path d="m17.7 6.3 1.4-1.4" />
        </>
      )}
      {name === "sparkle" && (
        <>
          <path d="M12 3 14.2 9.8 21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z" />
          <path d="M5 3v4" />
          <path d="M3 5h4" />
          <path d="M19 17v4" />
          <path d="M17 19h4" />
        </>
      )}
      {name === "heart" && (
        <path d="M20.8 7.8c0 5.2-8.8 10.2-8.8 10.2S3.2 13 3.2 7.8A4.4 4.4 0 0 1 11 5a4.4 4.4 0 0 1 9.8 2.8Z" />
      )}
      {name === "globe" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </>
      )}
      {name === "textZh" && (
        <>
          <path d="M4 6h16" />
          <path d="M12 6v13" />
          <path d="M7 11h10v5H7z" />
        </>
      )}
      {name === "textEn" && (
        <>
          <path d="M6 19V5h9" />
          <path d="M6 12h8" />
          <path d="M6 19h10" />
        </>
      )}
      {name === "about" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v7" />
          <path d="M12 7h.01" />
        </>
      )}
    </svg>
  );
}

interface SegOption<T> {
  value: T;
  label: string;
  icon?: IconName;
}
function Seg<T extends string | number>(props: {
  value: T;
  options: ReadonlyArray<SegOption<T>>;
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  const { value, options, onChange, disabled, className } = props;
  return (
    <div className={`seg${className ? ` ${className}` : ""}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- 通用：开关（toggle），role=switch + aria-checked ---------- */
function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  const { checked, onChange, label, disabled } = props;
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

function TileIcon(props: {
  icon: IconName;
}): JSX.Element {
  return (
    <span className="tile-icon" aria-hidden="true">
      <Icon name={props.icon} size={16} />
    </span>
  );
}

export default function App(): JSX.Element {
  const { t } = useTranslation("settings");
  const { settings } = useSettings();
  const [platformName, setPlatformName] = useState<SettingsPlatform>("macos");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("pay-model");
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [autoInstallUpdates, setAutoInstallUpdates] = useState(false);
  const lastSavedDraftRef = useRef<string | null>(null);

  /* ---------- 语言应用（M7）：以「已保存」的 settings.language 切 UI 语言；
     不用编辑中的 draft 避免下拉即变。 ---------- */
  useI18n(settings?.language);

  useEffect(() => {
    setPlatformName(resolveSettingsPlatform());
  }, []);

  // 用 settings 初始化本地草稿（仅在首次拿到 / 外部变更且未在编辑时同步）
  useEffect(() => {
    if (settings && draft === null) {
      const nextDraft = toDraft(settings);
      lastSavedDraftRef.current = JSON.stringify(nextDraft);
      setDraft(nextDraft);
    }
  }, [settings, draft]);

  const loading = draft === null;
  const viewDraft = draft ?? DEFAULT_DRAFT;

  /* ---------- 货币符号随「草稿语言」即时变：用户在语言下拉切换时，预览符号立刻跟随；
     若草稿尚无 language 字段则使用可视默认值，避免浏览器预览空白。 ---------- */
  const symbol = currencySymbol(viewDraft.language);
  const activeTitle =
    activeSection === "about" ? "关于" : t(`section.${activeSection === "pay-model" ? "payModel" : activeSection}`);

  /* 不可变更新 helper */
  const patch = (p: Partial<Draft>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setError(null);
  };

  /* ---------- 实时费率预览：每秒 = 月薪元 / 月工作天数 / 日工时 / 3600 ---------- */
  const preview = useMemo(() => {
    const d = draft ?? DEFAULT_DRAFT;
    const sal = parseFloat(d.salaryYuan) || 0;
    const h = parseFloat(d.dailyHours) || 0;
    const wd = parseFloat(d.workdaysPerMonth) || 0;
    if (h <= 0 || wd <= 0) return { sec: 0, hour: 0, day: 0 };
    const day = sal / wd;
    const hour = day / h;
    const sec = hour / 3600;
    return { sec, hour, day };
  }, [draft]);

  /* ---------- 自动保存：用户每次改动后短暂防抖，合法即落库 ---------- */
  useEffect(() => {
    if (!draft || !settings) return;

    const signature = JSON.stringify(draft);
    if (signature === lastSavedDraftRef.current) return;

    const timer = window.setTimeout(() => {
      const parsed = draftSchema.safeParse(draft);
      if (!parsed.success) {
        const key = parsed.error.issues[0]?.message ?? "error.invalidInput";
        setError(t(key));
        return;
      }

      const dto: SettingsDto = {
        ...settings,
        monthlySalaryCents: Math.round(parseFloat(draft.salaryYuan) * 100),
        dailyHours: parseFloat(draft.dailyHours),
        workdaysPerMonth: parseFloat(draft.workdaysPerMonth),
        overtimeMultiplierX100: draft.overtimeMultiplierX100,
        milestonesCents: parseMilestonesYuan(draft.milestonesYuan),
        theme: draft.theme,
        language: draft.language,
        notificationsEnabled: draft.notificationsEnabled,
        autostartEnabled: draft.autostartEnabled,
        displayDecimals: draft.displayDecimals,
        miniOpacityX100: draft.miniOpacityX100,
        transparencyEnabled: draft.transparencyEnabled,
      };

      updateSettings(dto)
        .then(() => {
          lastSavedDraftRef.current = signature;
          setError(null);
        })
        .catch((e) => {
          console.error("update_settings failed:", e);
          setError(t("error.saveFailed"));
        });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [draft, settings, t]);

  return (
    <>
      {/* 设置窗专有布局（仅本窗口；不污染共享 css） */}
      <style>{LAYOUT_CSS}</style>

      <div className="settings-shell" data-platform={platformName}>
        <aside className="settings-sidebar" aria-label={t("title")}>
          <div className="sidebar-brand">
            <div className="app-mark">P</div>
            <div>
              <div className="brand-title">PayPulse</div>
              <div className="brand-subtitle">{t("title")}</div>
            </div>
          </div>

          <nav className="sidebar-nav">
            <div className="side-title" aria-current="false">
              <span>{t("title")}</span>
            </div>
            <button
              className={`side-item ${activeSection === "pay-model" ? "active" : ""}`}
              type="button"
              aria-current={activeSection === "pay-model" ? "page" : undefined}
              onClick={() => setActiveSection("pay-model")}
            >
              <TileIcon icon="pay" />
              <span>{t("section.payModel")}</span>
            </button>
            <button
              className={`side-item ${activeSection === "appearance" ? "active" : ""}`}
              type="button"
              aria-current={activeSection === "appearance" ? "page" : undefined}
              onClick={() => setActiveSection("appearance")}
            >
              <TileIcon icon="appearance" />
              <span>{t("section.appearance")}</span>
            </button>
            <button
              className={`side-item ${activeSection === "behavior" ? "active" : ""}`}
              type="button"
              aria-current={activeSection === "behavior" ? "page" : undefined}
              onClick={() => setActiveSection("behavior")}
            >
              <TileIcon icon="behavior" />
              <span>{t("section.behavior")}</span>
            </button>
            <button
              className={`side-item ${activeSection === "about" ? "active" : ""}`}
              type="button"
              aria-current={activeSection === "about" ? "page" : undefined}
              onClick={() => setActiveSection("about")}
            >
              <TileIcon icon="about" />
              <span>关于</span>
            </button>
          </nav>
        </aside>

        <main className="settings-main">
          <div className="main-scroll">
            <header className="page-head" id="general">
              <h1>{activeTitle}</h1>
            </header>

            {activeSection === "pay-model" && (
            <section className="settings-section" id="pay-model">
              <h2>{t("section.payModel")}</h2>
              <div className="settings-card">
                <label className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.monthlySalary", { symbol })}</span>
                  </span>
                  <input
                    id="salaryYuan"
                    name="salaryYuan"
                    className="native-input"
                    inputMode="decimal"
                    value={viewDraft.salaryYuan}
                    disabled={loading}
                    onChange={(e) => patch({ salaryYuan: e.target.value })}
                  />
                </label>

                <label className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.dailyHours")}</span>
                  </span>
                  <input
                    id="dailyHours"
                    name="dailyHours"
                    className="native-input"
                    inputMode="decimal"
                    value={viewDraft.dailyHours}
                    disabled={loading}
                    onChange={(e) => patch({ dailyHours: e.target.value })}
                  />
                </label>

                <label className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.workdaysPerMonth")}</span>
                  </span>
                  <input
                    id="workdaysPerMonth"
                    name="workdaysPerMonth"
                    className="native-input"
                    inputMode="decimal"
                    value={viewDraft.workdaysPerMonth}
                    disabled={loading}
                    onChange={(e) => patch({ workdaysPerMonth: e.target.value })}
                  />
                </label>

                <div className="settings-row preview-row">
                  <span className="row-copy">
                    <span className="row-title">{t("preview.perSec")}</span>
                  </span>
                  <div className="rate-preview">
                    <div className="rate-primary">
                      {symbol}
                      {preview.sec.toFixed(4)}
                    </div>
                    <div className="rate-metric">
                      <span>{t("preview.hourly")}</span>
                      <strong>
                        {symbol}
                        {preview.hour.toFixed(1)}
                      </strong>
                    </div>
                    <div className="rate-metric">
                      <span>{t("preview.dailyGoal")}</span>
                      <strong>
                        {symbol}
                        {Math.round(preview.day).toLocaleString("en-US")}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            )}

            {activeSection === "appearance" && (
            <section className="settings-section" id="appearance">
              <h2>{t("section.appearance")}</h2>
              <div className="settings-card">
                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.windowOpacity")}</span>
                    <span className="row-desc">{viewDraft.miniOpacityX100}%</span>
                  </span>
                  <div className="opacity-control">
                    <span className="opacity-preview" aria-hidden="true">
                      <span style={{ opacity: viewDraft.miniOpacityX100 / 100 }}>
                        {symbol}238.118
                      </span>
                    </span>
                    <input
                      type="range"
                      className="slider"
                      min={35}
                      max={100}
                      value={viewDraft.miniOpacityX100}
                      disabled={loading || !viewDraft.transparencyEnabled}
                      onChange={(e) => patch({ miniOpacityX100: Number(e.target.value) })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("opt.enableTransparency")}</span>
                    <span className="row-desc">{t("opt.enableTransparencyDesc")}</span>
                  </span>
                  <Toggle
                    label={t("opt.enableTransparency")}
                    checked={viewDraft.transparencyEnabled}
                    disabled={loading}
                    onChange={(v) => patch({ transparencyEnabled: v })}
                  />
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("opt.decimals")}</span>
                    <span className="row-desc">{t("opt.decimalsDesc")}</span>
                  </span>
                  <Seg<number>
                    value={viewDraft.displayDecimals}
                    disabled={loading}
                    onChange={(v) => patch({ displayDecimals: v })}
                    options={[
                      { value: 0, label: "0" },
                      { value: 1, label: "1" },
                      { value: 2, label: "2" },
                      { value: 3, label: "3" },
                      { value: 4, label: "4" },
                    ]}
                  />
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.theme")}</span>
                  </span>
                  <Seg<Theme>
                    className="theme-seg"
                    value={viewDraft.theme}
                    disabled={loading}
                    onChange={(v) => patch({ theme: v })}
                    options={[
                      { value: "system", label: t("theme.system"), icon: "monitor" },
                      { value: "dark", label: t("theme.dark"), icon: "moon" },
                      { value: "light", label: t("theme.light"), icon: "sun" },
                      { value: "transparent", label: t("theme.transparent"), icon: "sparkle" },
                      { value: "macaron", label: t("theme.macaron"), icon: "heart" },
                    ]}
                  />
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.language")}</span>
                  </span>
                  <Seg<Language>
                    value={viewDraft.language}
                    disabled={loading}
                    onChange={(v) => patch({ language: v })}
                    options={[
                      { value: "system", label: t("language.system"), icon: "globe" },
                      { value: "zh", label: t("language.zh"), icon: "textZh" },
                      { value: "en", label: t("language.en"), icon: "textEn" },
                    ]}
                  />
                </div>
              </div>
            </section>
            )}

            {activeSection === "behavior" && (
            <section className="settings-section" id="behavior">
              <h2>{t("section.behavior")}</h2>
              <div className="settings-card">
                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("opt.milestoneAlert")}</span>
                    <span className="row-desc">{t("opt.milestoneAlertDesc")}</span>
                  </span>
                  <Toggle
                    label={t("opt.milestoneAlert")}
                    checked={viewDraft.notificationsEnabled}
                    disabled={loading}
                    onChange={(v) => patch({ notificationsEnabled: v })}
                  />
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("opt.autostart")}</span>
                    <span className="row-desc">{t("opt.autostartDesc")}</span>
                  </span>
                  <Toggle
                    label={t("opt.autostart")}
                    checked={viewDraft.autostartEnabled}
                    disabled={loading}
                    onChange={(v) => patch({ autostartEnabled: v })}
                  />
                </div>

                <div className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("opt.overtime")}</span>
                    <span className="row-desc">{t("opt.overtimeDesc")}</span>
                  </span>
                  <div className="stepper">
                    <button
                      type="button"
                      aria-label={t("stepper.decreaseOvertime")}
                      disabled={loading}
                      onClick={() =>
                        patch({
                          // 下限 100（即 1.0×）
                          overtimeMultiplierX100: Math.max(
                            100,
                            viewDraft.overtimeMultiplierX100 - 10,
                          ),
                        })
                      }
                    >
                      <Icon name="minus" size={15} />
                    </button>
                    <div className="stepper-value">
                      {(viewDraft.overtimeMultiplierX100 / 100).toFixed(1)}×
                    </div>
                    <button
                      type="button"
                      aria-label={t("stepper.increaseOvertime")}
                      disabled={loading}
                      onClick={() =>
                        patch({
                          // 上限 300（即 3.0×），与原型 stepper 一致
                          overtimeMultiplierX100: Math.min(
                            300,
                            viewDraft.overtimeMultiplierX100 + 10,
                          ),
                        })
                      }
                    >
                      <Icon name="plus" size={15} />
                    </button>
                  </div>
                </div>

                <label className="settings-row">
                  <span className="row-copy">
                    <span className="row-title">{t("field.milestones")}</span>
                  </span>
                  <input
                    id="milestonesYuan"
                    name="milestonesYuan"
                    className="native-input wide"
                    inputMode="text"
                    placeholder={t("field.milestonesPlaceholder")}
                    value={viewDraft.milestonesYuan}
                    disabled={loading}
                    onChange={(e) => patch({ milestonesYuan: e.target.value })}
                  />
                </label>
              </div>
            </section>
            )}

            {activeSection === "about" && (
              <section className="settings-section" id="about">
                <h2>关于</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">检查更新</span>
                    </span>
                    <button className="native-button secondary inline-action" type="button">
                      检查更新
                    </button>
                  </div>

                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">自动检查更新</span>
                    </span>
                    <Toggle
                      label="自动检查更新"
                      checked={autoCheckUpdates}
                      onChange={setAutoCheckUpdates}
                    />
                  </div>

                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">自动安装更新</span>
                    </span>
                    <Toggle
                      label="自动安装更新"
                      checked={autoInstallUpdates}
                      onChange={setAutoInstallUpdates}
                    />
                  </div>

                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">开发者</span>
                    </span>
                    <span className="row-value">Snychng</span>
                  </div>

                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">报告 Bug</span>
                    </span>
                    <a className="external-link" href={BUG_REPORT_URL} target="_blank" rel="noreferrer">
                      {BUG_REPORT_URL}
                    </a>
                  </div>

                  <div className="settings-row">
                    <span className="row-copy">
                      <span className="row-title">开源地址</span>
                    </span>
                    <a className="external-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                      Snychng/paypulse
                    </a>
                  </div>
                </div>
              </section>
            )}

            {error && (
              <div className="error-line" role="alert">
                <span>!</span>
                {error}
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}

/* ---------- 设置窗专有布局：macOS / Windows 原生设置页语义 ---------- */
const LAYOUT_CSS = `
  :root {
    color-scheme: light dark;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  html,
  body,
  #root {
    width: 100%;
    height: 100%;
    margin: 0;
  }

  html {
    scroll-behavior: smooth;
  }

  body {
    overflow: hidden;
    background: transparent;
    color: var(--text);
  }

  button,
  input {
    font: inherit;
  }

  button {
    cursor: pointer;
  }

  button:disabled,
  input:disabled {
    cursor: not-allowed;
  }

  .settings-shell {
    --window-bg: #ffffff;
    --sidebar-bg: #f0f0f0;
    --sidebar-active: #e4e4e4;
    --card-bg: #ffffff;
    --card-border: rgba(0, 0, 0, 0.08);
    --separator: rgba(0, 0, 0, 0.065);
    --text: #202124;
    --muted: #8c8f94;
    --muted-strong: #5f6368;
    --field-bg: #ffffff;
    --field-border: rgba(0, 0, 0, 0.1);
    --soft-bg: #f7f7f7;
    --soft-layer: rgba(120, 120, 128, 0.18);
    --soft-layer-strong: rgba(120, 120, 128, 0.26);
    --toggle-bg: rgba(120, 120, 128, 0.28);
    --toggle-knob: #ffffff;
    --toggle-off-knob: #5f6368;
    --accent: #339cff;
    --accent-press: #2388e8;
    --danger: #d70015;
    --shadow: none;
    --card-radius: 12px;
    --control-radius: 8px;
    --content-width: 660px;
    --control-width: 300px;
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr);
    overflow: hidden;
    background: var(--window-bg);
    color: var(--text);
    image-rendering: auto;
  }

  .settings-shell[data-platform="windows"] {
    --window-bg: #f3f3f3;
    --sidebar-bg: #f7f7f7;
    --sidebar-active: #e8e8e8;
    --card-bg: #fbfbfb;
    --card-border: rgba(0, 0, 0, 0.08);
    --separator: rgba(0, 0, 0, 0.06);
    --field-bg: #ffffff;
    --soft-bg: #f7f7f7;
    --accent: #0067c0;
    --accent-press: #005aa7;
    --card-radius: 8px;
    --control-radius: 6px;
    grid-template-columns: 210px minmax(0, 1fr);
  }

  .settings-sidebar {
    min-width: 0;
    padding: 22px 10px 14px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--separator);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .sidebar-brand {
    min-height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
  }

  .app-mark {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    color: var(--muted-strong);
    font-size: 13px;
    font-weight: 680;
    letter-spacing: 0;
    background: transparent;
    box-shadow: none;
  }

  .settings-shell[data-platform="windows"] .app-mark {
    background: transparent;
  }

  .brand-title {
    font-size: 13px;
    font-weight: 650;
    line-height: 1.2;
    letter-spacing: 0;
  }

  .brand-subtitle {
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }

  .sidebar-nav {
    display: grid;
    gap: 2px;
  }

  .side-title,
  .side-item {
    min-width: 0;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 12px;
    color: var(--text);
    text-decoration: none;
    border-radius: 12px;
    font-size: 13px;
    letter-spacing: 0;
  }

  .side-title {
    color: var(--muted);
    font-weight: 520;
    cursor: default;
    user-select: none;
    padding-left: 14px;
  }

  .side-item {
    border: 0;
    background: transparent;
    text-align: left;
    font-weight: 520;
    transition: background 160ms ease, transform 160ms ease, color 160ms ease;
  }

  .side-title span:last-child,
  .side-item span:last-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .side-item:hover {
    background: rgba(0, 0, 0, 0.045);
  }

  .side-item:active {
    transform: scale(0.985);
  }

  .side-item.active {
    background: var(--sidebar-active);
    font-weight: 590;
  }

  .side-title .tile-icon {
    color: var(--muted);
  }

  .settings-shell[data-platform="windows"] .side-item {
    height: 34px;
    border-radius: 7px;
  }

  .tile-icon {
    width: 18px;
    height: 18px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--muted-strong);
    box-shadow: none;
  }

  .settings-shell[data-platform="windows"] .tile-icon {
    border-radius: 5px;
  }

  .side-item.active .tile-icon {
    color: var(--text);
  }

  .settings-main {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    background: var(--window-bg);
  }

  .main-scroll {
    min-height: 0;
    overflow: auto;
    padding: 34px 32px 22px;
    scrollbar-width: thin;
    scrollbar-color: rgba(120, 120, 128, 0.32) transparent;
  }

  .main-scroll::-webkit-scrollbar {
    width: 12px;
  }

  .main-scroll::-webkit-scrollbar-thumb {
    border: 4px solid transparent;
    border-radius: 999px;
    background: rgba(120, 120, 128, 0.32);
    background-clip: content-box;
  }

  .page-head {
    width: min(100%, var(--content-width));
    margin: 0 auto 22px;
  }

  .page-head h1 {
    margin: 0;
    font-size: 20px;
    line-height: 1.25;
    font-weight: 700;
    letter-spacing: 0;
  }

  .settings-section {
    width: min(100%, var(--content-width));
    margin: 18px auto 0;
  }

  .settings-section:first-of-type {
    margin-top: 0;
  }

  .settings-section h2 {
    margin: 0 0 7px 14px;
    color: var(--muted-strong);
    font-size: 12px;
    line-height: 1.25;
    font-weight: 650;
    letter-spacing: 0;
  }

  .settings-card {
    overflow: hidden;
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    background: var(--card-bg);
    box-shadow: var(--shadow);
    backdrop-filter: none;
  }

  .settings-shell[data-platform="windows"] .settings-card {
    box-shadow: none;
  }

  .settings-row {
    min-width: 0;
    min-height: 48px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, var(--control-width));
    align-items: center;
    column-gap: 18px;
    padding: 8px 14px 8px 16px;
    border-bottom: 1px solid var(--separator);
  }

  .settings-row:last-child {
    border-bottom: 0;
  }

  .row-copy {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .row-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 620;
    line-height: 1.25;
    letter-spacing: 0;
  }

  .row-desc {
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.25;
  }

  .native-input {
    justify-self: end;
    width: min(190px, 100%);
    height: 30px;
    border: 1px solid var(--field-border);
    border-radius: var(--control-radius);
    background: var(--field-bg);
    color: var(--text);
    padding: 0 10px;
    outline: none;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
  }

  .native-input.wide {
    width: 100%;
  }

  .native-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent);
  }

  .row-value,
  .external-link {
    min-width: 0;
    justify-self: end;
    color: var(--muted-strong);
    font-size: 12.5px;
    line-height: 1.25;
  }

  .external-link {
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: right;
    color: var(--accent);
    text-decoration: none;
  }

  .external-link:hover {
    text-decoration: underline;
  }

  .native-input:disabled,
  .slider:disabled,
  .seg button:disabled,
  .toggle:disabled,
  .stepper button:disabled {
    opacity: 0.52;
  }

  .preview-row {
    align-items: center;
  }

  .rate-preview {
    justify-self: end;
    width: min(100%, 300px);
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(92px, 1.05fr) minmax(64px, 0.85fr) minmax(72px, 0.9fr);
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
    border-radius: 9px;
    border: 1px solid var(--field-border);
    background: var(--soft-bg);
  }

  .settings-shell[data-platform="windows"] .rate-preview {
    border-radius: 6px;
  }

  .rate-primary {
    color: var(--accent);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 18px;
    font-weight: 720;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .rate-metric {
    min-width: 0;
    display: grid;
    gap: 2px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .rate-metric span {
    color: var(--muted);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rate-metric strong {
    color: var(--muted-strong);
    font-size: 12px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opacity-control {
    justify-self: end;
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    overflow: hidden;
  }

  .opacity-preview {
    min-width: 0;
    height: 28px;
    display: grid;
    place-items: center;
    border: 1px solid var(--field-border);
    border-radius: 8px;
    background: var(--soft-bg);
    color: var(--accent);
    font-size: 11.5px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
  }

  .opacity-preview span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings-shell[data-platform="windows"] .opacity-preview {
    border-radius: 4px;
  }

  .slider {
    width: 100%;
    min-width: 0;
    margin: 0;
    accent-color: var(--accent);
  }

  .slider:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 26%, transparent);
    outline-offset: 4px;
    border-radius: 999px;
  }

  .toggle {
    width: 38px;
    height: 22px;
    justify-self: end;
    position: relative;
    flex: none;
    border: 0;
    border-radius: 999px;
    background: var(--toggle-bg);
    padding: 2px;
    transition: background 180ms ease, box-shadow 180ms ease;
  }

  .toggle .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--toggle-knob);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
    transition: transform 180ms ease;
  }

  .toggle[aria-checked="true"] {
    background: var(--accent);
  }

  .toggle[aria-checked="true"] .knob {
    transform: translateX(16px);
  }

  .settings-shell[data-platform="windows"] .toggle {
    width: 42px;
    height: 22px;
    border: 1px solid rgba(0, 0, 0, 0.22);
    background: var(--toggle-bg);
  }

  .settings-shell[data-platform="windows"] .toggle .knob {
    width: 12px;
    height: 12px;
    top: 4px;
    left: 5px;
    box-shadow: none;
    background: var(--toggle-off-knob);
  }

  .settings-shell[data-platform="windows"] .toggle[aria-checked="true"] {
    border-color: var(--accent);
    background: var(--accent);
  }

  .settings-shell[data-platform="windows"] .toggle[aria-checked="true"] .knob {
    transform: translateX(18px);
    background: var(--toggle-knob);
  }

  .toggle:focus-visible,
  .seg button:focus-visible,
  .stepper button:focus-visible,
  .native-button:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 26%, transparent);
    outline-offset: 3px;
  }

  .seg {
    justify-self: end;
    width: min(100%, 300px);
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    min-height: 30px;
    padding: 2px;
    border-radius: 10px;
    background: var(--soft-layer);
  }

  .seg.theme-seg {
    width: min(100%, 430px);
  }

  .seg button {
    min-width: 0;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted-strong);
    padding: 0 7px;
    font-size: 12px;
    font-weight: 560;
    transition: color 160ms ease, background 160ms ease, box-shadow 160ms ease;
  }

  .seg button span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .seg button svg {
    flex: none;
  }

  .seg button[aria-pressed="true"] {
    color: var(--text);
    background: var(--field-bg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .settings-shell[data-platform="windows"] .seg {
    border: 1px solid var(--field-border);
    border-radius: 4px;
    padding: 0;
    background: var(--field-bg);
  }

  .settings-shell[data-platform="windows"] .seg button {
    border-right: 1px solid var(--separator);
    border-radius: 0;
  }

  .settings-shell[data-platform="windows"] .seg button:first-child {
    border-radius: 3px 0 0 3px;
  }

  .settings-shell[data-platform="windows"] .seg button:last-child {
    border-right: 0;
    border-radius: 0 3px 3px 0;
  }

  .settings-shell[data-platform="windows"] .seg button[aria-pressed="true"] {
    color: var(--text);
    background: var(--sidebar-active);
    box-shadow: none;
  }

  .stepper {
    justify-self: end;
    width: 118px;
    height: 30px;
    display: inline-grid;
    grid-template-columns: 30px minmax(0, 1fr) 30px;
    overflow: hidden;
    border: 1px solid var(--field-border);
    border-radius: var(--control-radius);
    background: var(--field-bg);
  }

  .stepper button {
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 18px;
    line-height: 1;
    transition: background 160ms ease;
  }

  .stepper button:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .stepper button:active {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .stepper-value {
    display: grid;
    place-items: center;
    border-inline: 1px solid var(--separator);
    color: var(--text);
    font-size: 12.5px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }

  .native-button {
    min-width: 84px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 0;
    border-radius: 8px;
    padding: 0 14px;
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    transition: background 160ms ease, transform 160ms ease, opacity 160ms ease;
  }

  .native-button svg {
    flex: none;
  }

  .native-button:active {
    transform: scale(0.985);
  }

  .native-button.primary {
    color: #fff;
    background: var(--accent);
  }

  .native-button.primary:hover {
    background: var(--accent-press);
  }

  .native-button.secondary {
    color: var(--text);
    background: var(--soft-layer);
  }

  .native-button.secondary:hover {
    background: var(--soft-layer-strong);
  }

  .native-button.inline-action {
    justify-self: end;
    min-width: 86px;
  }

  .native-button:disabled {
    opacity: 0.5;
  }

  .settings-shell[data-platform="windows"] .native-button {
    height: 32px;
    border-radius: 4px;
  }

  .error-line {
    margin: 14px 0 4px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--danger);
    font-size: 13px;
    font-weight: 600;
  }

  .error-line span {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: #fff;
    background: var(--danger);
    font-size: 12px;
    font-weight: 800;
  }

  @media (max-width: 760px) {
    .settings-shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr);
      --control-width: 100%;
    }

    .settings-sidebar {
      padding: 14px 16px 10px;
      border-right: 0;
      border-bottom: 1px solid var(--separator);
      gap: 12px;
    }

    .sidebar-nav {
      display: flex;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .side-item {
      flex: none;
    }

    .side-title {
      flex: none;
    }

    .main-scroll {
      padding: 22px 18px 18px;
    }

    .settings-row {
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 13px 14px;
    }

    .native-input,
    .native-input.wide,
    .opacity-control,
    .rate-preview,
    .seg,
    .stepper,
    .native-button.inline-action,
    .row-value,
    .external-link {
      justify-self: stretch;
      width: 100%;
    }

    .row-value,
    .external-link {
      text-align: left;
    }

    .rate-preview {
      min-width: 0;
      grid-template-columns: 1fr;
      align-items: start;
      gap: 8px;
    }

    .rate-metric {
      text-align: left;
    }

  }

  @media (max-width: 520px) {
    .sidebar-brand {
      display: none;
    }

    .side-item {
      width: max-content;
      max-width: 180px;
    }

    .page-head h1 {
      font-size: 24px;
    }

  }
`;
