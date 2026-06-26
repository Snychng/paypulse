/* ============================================================
   settings/App.tsx — PayPulse 设置窗口 UI（逐像素对齐 design/settings.html）
   职责：用本地副本编辑 SettingsDto，做 zod 前端校验，调用 updateSettings 落库。
   约束：React 不持有金钱权威——所有变更经 Rust 引擎重算+持久化+广播。
   单位约定：金额输入「元」，落库前 ×100 转「分」；倍率展示「×倍」，存 x100。
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useSettings } from "@/hooks/useSettings";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { updateSettings } from "@/shared/ipc";
import { currencySymbol } from "@/shared/format";
import { Sprite, Icon } from "@/pixel";
import type { SettingsDto, Theme, Language } from "@/shared/types";

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

/* ---------- 通用：分段控件（seg），按钮用 aria-pressed 对齐 pixel.css ---------- */
interface SegOption<T> {
  value: T;
  label: string;
}
function Seg<T extends string | number>(props: {
  value: T;
  options: ReadonlyArray<SegOption<T>>;
  onChange: (v: T) => void;
  disabled?: boolean;
}): JSX.Element {
  const { value, options, onChange, disabled } = props;
  return (
    <div className="seg" style={{ boxShadow: "none" }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- 通用：开关（toggle），role=switch + aria-checked 对齐 pixel.css ---------- */
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
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <span className="knob" />
    </button>
  );
}

export default function App(): JSX.Element {
  const { t } = useTranslation("settings");
  const { settings } = useSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ---------- 语言应用（M7）：以「已保存」的 settings.language 切 UI 语言，
     与主题同源（保存后整窗换语言，符合预期）；不用编辑中的 draft 避免下拉即变。 ---------- */
  useI18n(settings?.language);

  /* ---------- 主题应用（M6）：以「已保存」的 settings.theme 驱动 <html data-theme>，
     不用编辑中的 draft——保存后主题即时生效，避免与旧 draft 副作用两处打架。 ---------- */
  useTheme(settings?.theme);

  /* ---------- 货币符号随「草稿语言」即时变：用户在语言下拉切换时，预览符号立刻跟随；
     若草稿尚无 language 字段则回退已保存值，再回退 system。 ---------- */
  const symbol = currencySymbol(draft?.language ?? settings?.language ?? "system");

  // 用 settings 初始化本地草稿（仅在首次拿到 / 外部变更且未在编辑时同步）
  useEffect(() => {
    if (settings && draft === null) setDraft(toDraft(settings));
  }, [settings, draft]);

  /* 不可变更新 helper */
  const patch = (p: Partial<Draft>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setSaved(false);
    setError(null);
  };

  /* ---------- 实时费率预览：每秒 = 月薪元 / 月工作天数 / 日工时 / 3600 ---------- */
  const preview = useMemo(() => {
    if (!draft) return { sec: 0, hour: 0, day: 0 };
    const sal = parseFloat(draft.salaryYuan) || 0;
    const h = parseFloat(draft.dailyHours) || 0;
    const wd = parseFloat(draft.workdaysPerMonth) || 0;
    if (h <= 0 || wd <= 0) return { sec: 0, hour: 0, day: 0 };
    const day = sal / wd;
    const hour = day / h;
    const sec = hour / 3600;
    return { sec, hour, day };
  }, [draft]);

  /* ---------- 保存：zod 校验 → 组装 DTO（元×100、倍率原样）→ updateSettings ---------- */
  const handleSave = async (): Promise<void> => {
    if (!draft || !settings) return;
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) {
      // issues[0].message 现为 i18n key（如 "error.salaryPositive"）；用 t 翻译
      const key = parsed.error.issues[0]?.message ?? "error.invalidInput";
      setError(t(key));
      return;
    }
    // 组装权威 DTO：以原 settings 为基底，覆盖本窗口可编辑字段（不丢失 currency/windowsIconNumber 等）
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
    try {
      setSaving(true);
      setError(null);
      await updateSettings(dto);
      setSaved(true);
      // 短暂「已保存」反馈后复位
      setTimeout(() => setSaved(false), 1200);
    } catch (e) {
      // 全面错误处理：保留可读文案，不泄露内部细节
      console.error("update_settings failed:", e);
      setError(t("error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  /* ---------- 取消：隐藏窗口（保存后亦可隐藏，见硬约束） ---------- */
  const handleClose = (): void => {
    getCurrentWindow()
      .hide()
      .catch(() => {
        /* 非 Tauri webview（如浏览器预览）忽略 */
      });
  };

  const loading = draft === null;
  // 主题副作用统一交给 useTheme(settings?.theme)（基于已保存设置，含 system 跟随）。
  // 旧的 draft 驱动 data-theme 副作用已移除，避免与 useTheme 两处争抢 <html data-theme>。

  return (
    <>
      {/* 设置窗专有布局（仅本窗口；不污染共享 css） */}
      <style>{LAYOUT_CSS}</style>

      <div className="window crt">
        {/* 标题栏 */}
        <div className="titlebar">
          <Sprite name="coin" scale={3} />
          <span className="name">
            Pay<span style={{ color: "var(--money)" }}>Pulse</span>{" "}
            <span style={{ color: "var(--ink)" }}>· {t("title")}</span>
          </span>
          <div className="tb-btns">
            <button className="tb-btn" type="button" aria-label={t("close")} onClick={handleClose}>
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>

        <div className="content scroll">
          {/* ============ PAY MODEL ============ */}
          <section className="section">
            <div className="sh">
              <span className="ico" style={{ color: "var(--money)" }}>
                <Icon name="chart" size={14} />
              </span>
              <span className="t">{t("section.payModel")}</span>
            </div>
            <div className="sbody">
              <div className="row3">
                <label className="field">
                  {/* 月薪标签：货币符号随草稿语言插值（en → $，zh → ¥） */}
                  <span className="label">{t("field.monthlySalary", { symbol })}</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={draft?.salaryYuan ?? ""}
                    disabled={loading}
                    onChange={(e) => patch({ salaryYuan: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="label">{t("field.dailyHours")}</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={draft?.dailyHours ?? ""}
                    disabled={loading}
                    onChange={(e) => patch({ dailyHours: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="label">{t("field.workdaysPerMonth")}</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={draft?.workdaysPerMonth ?? ""}
                    disabled={loading}
                    onChange={(e) => patch({ workdaysPerMonth: e.target.value })}
                  />
                </label>
              </div>

              {/* 实时费率预览（货币符号随草稿语言即时变） */}
              <div className="preview">
                <div>
                  <div className="label">{t("preview.perSec")}</div>
                  <div className="big">
                    {symbol}
                    {preview.sec.toFixed(4)}
                  </div>
                </div>
                <div className="lbls">
                  <div className="label">{t("preview.hourly")}</div>
                  <b>
                    {symbol}
                    {preview.hour.toFixed(1)}
                  </b>
                  <br />
                  <div className="label" style={{ marginTop: 4 }}>
                    {t("preview.dailyGoal")}
                  </div>
                  <b>
                    {symbol}
                    {Math.round(preview.day).toLocaleString("en-US")}
                  </b>
                </div>
              </div>
            </div>
          </section>

          {/* ============ APPEARANCE ============ */}
          <section className="section">
            <div className="sh">
              <span className="ico" style={{ color: "var(--money)" }}>
                <Icon name="sun" size={14} />
              </span>
              <span className="t">{t("section.appearance")}</span>
            </div>
            <div className="sbody">
              {/* 窗口透明度（slider 35–100）+ 透明度开关 */}
              <div className="field">
                <span className="label">{t("field.windowOpacity")}</span>
                <div className="opwrap">
                  <div className="opmini">
                    <div
                      className="pane"
                      style={{ opacity: draft ? draft.miniOpacityX100 / 100 : 1 }}
                    >
                      {/* 透明度预览迷你窗内的装饰示例金额：货币符号亦随草稿语言 */}
                      <span className="n">{symbol}238.118</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    className="slider grow"
                    min={35}
                    max={100}
                    value={draft?.miniOpacityX100 ?? 92}
                    disabled={loading || (draft ? !draft.transparencyEnabled : true)}
                    onChange={(e) => patch({ miniOpacityX100: Number(e.target.value) })}
                  />
                  <span
                    className="font-term"
                    style={{ fontSize: 18, color: "var(--money)", width: 42, textAlign: "right" }}
                  >
                    {draft?.miniOpacityX100 ?? 92}%
                  </span>
                </div>
              </div>

              {/* 启用透明度（toggle） */}
              <div className="opt">
                <div>
                  <div className="ttl">{t("opt.enableTransparency")}</div>
                  <div className="desc">{t("opt.enableTransparencyDesc")}</div>
                </div>
                <Toggle
                  label={t("opt.enableTransparency")}
                  checked={draft?.transparencyEnabled ?? false}
                  disabled={loading}
                  onChange={(v) => patch({ transparencyEnabled: v })}
                />
              </div>

              {/* 小数位数（seg 0–4） */}
              <div className="opt">
                <div>
                  <div className="ttl">{t("opt.decimals")}</div>
                  <div className="desc">{t("opt.decimalsDesc")}</div>
                </div>
                <Seg<number>
                  value={draft?.displayDecimals ?? 3}
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

              {/* 主题 / 语言 */}
              <div className="row2">
                <div className="field">
                  <span className="label">{t("field.theme")}</span>
                  <Seg<Theme>
                    value={draft?.theme ?? "system"}
                    disabled={loading}
                    onChange={(v) => patch({ theme: v })}
                    options={[
                      { value: "system", label: t("theme.system") },
                      { value: "dark", label: t("theme.dark") },
                      { value: "light", label: t("theme.light") },
                    ]}
                  />
                </div>
                <div className="field">
                  <span className="label">{t("field.language")}</span>
                  <Seg<Language>
                    value={draft?.language ?? "system"}
                    disabled={loading}
                    onChange={(v) => patch({ language: v })}
                    options={[
                      { value: "system", label: t("language.system") },
                      { value: "zh", label: t("language.zh") },
                      { value: "en", label: t("language.en") },
                    ]}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ============ BEHAVIOR ============ */}
          <section className="section">
            <div className="sh">
              <span className="ico" style={{ color: "var(--money)" }}>
                <Icon name="settings" size={14} />
              </span>
              <span className="t">{t("section.behavior")}</span>
            </div>
            <div className="sbody">
              {/* 里程碑提醒 */}
              <div className="opt">
                <div>
                  <div className="ttl">{t("opt.milestoneAlert")}</div>
                  <div className="desc">{t("opt.milestoneAlertDesc")}</div>
                </div>
                <Toggle
                  label={t("opt.milestoneAlert")}
                  checked={draft?.notificationsEnabled ?? false}
                  disabled={loading}
                  onChange={(v) => patch({ notificationsEnabled: v })}
                />
              </div>

              {/* 开机自启 */}
              <div className="opt">
                <div>
                  <div className="ttl">{t("opt.autostart")}</div>
                  <div className="desc">{t("opt.autostartDesc")}</div>
                </div>
                <Toggle
                  label={t("opt.autostart")}
                  checked={draft?.autostartEnabled ?? false}
                  disabled={loading}
                  onChange={(v) => patch({ autostartEnabled: v })}
                />
              </div>

              {/* 加班倍率（stepper，步进 0.1×，展示 ×倍 / 存 x100） */}
              <div className="opt">
                <div>
                  <div className="ttl">{t("opt.overtime")}</div>
                  <div className="desc">{t("opt.overtimeDesc")}</div>
                </div>
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
                          (draft?.overtimeMultiplierX100 ?? 150) - 10,
                        ),
                      })
                    }
                  >
                    −
                  </button>
                  <div className="val">
                    {((draft?.overtimeMultiplierX100 ?? 150) / 100).toFixed(1)}×
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
                          (draft?.overtimeMultiplierX100 ?? 150) + 10,
                        ),
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>

              {/* 里程碑数值（逗号分隔的「元」，解析为分数组） */}
              <div className="field">
                <span className="label">{t("field.milestones")}</span>
                <input
                  className="input"
                  inputMode="text"
                  placeholder={t("field.milestonesPlaceholder")}
                  value={draft?.milestonesYuan ?? ""}
                  disabled={loading}
                  onChange={(e) => patch({ milestonesYuan: e.target.value })}
                />
              </div>
            </div>
          </section>

          {/* 校验/保存错误文案 */}
          {error && <div className="errline">⚠ {error}</div>}
        </div>

        {/* 底部操作 */}
        <div className="footer">
          <button className="btn ghost" type="button" disabled={saving} onClick={handleClose}>
            {t("action.cancel")}
          </button>
          <button
            className={`btn save go${saved ? " wig" : ""}`}
            type="button"
            disabled={loading || saving}
            onClick={() => {
              void handleSave();
            }}
          >
            <Icon name="power" size={13} />
            <span>{saved ? t("action.saved") : saving ? t("action.saving") : t("action.save")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------- 设置窗专有布局（顶层 <style>，对齐 design/settings.html） ---------- */
const LAYOUT_CSS = `
  body { display: grid; place-items: center; background: #0c0d18;
    background-image: radial-gradient(120% 120% at 50% 0%, #1a1c2c 0%, #0c0d18 70%); padding: 18px; }
  .window { width: 520px; background: var(--panel); border: var(--b) solid var(--ink); box-shadow: 7px 7px 0 var(--hard);
    background-image: linear-gradient(45deg, var(--dither) 25%, transparent 25% 75%, var(--dither) 75%); background-size: var(--px) var(--px); }
  .titlebar { display: flex; align-items: center; gap: 8px; padding: 7px 9px; background: var(--inset); border-bottom: var(--b) solid var(--ink); }
  .titlebar .name { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 14px; letter-spacing: 1px; }
  .tb-btns { margin-left: auto; display: flex; gap: 5px; }
  .tb-btn { width: 22px; height: 22px; display: grid; place-items: center; background: var(--panel-2); border: 2px solid var(--ink); color: var(--ink-dim); }

  .content { padding: 16px; display: grid; gap: 14px; max-height: 74vh; }
  .section { background: var(--inset); border: var(--b) solid var(--ink); }
  .section > .sh { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 2px dashed var(--line); }
  .section > .sh .t { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 13px; letter-spacing: 1px; }
  .sbody { padding: 12px; display: grid; gap: 12px; }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .field .label { margin-bottom: 5px; display: block; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .opt .desc { font-family: 'DotGothic16'; font-size: 11px; color: var(--ink-dim); margin-top: 3px; }
  .opt .ttl { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 13px; }

  .preview { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
    background: var(--panel-2); border: var(--b) solid var(--ink); }
  .preview .big { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 26px; color: var(--gain); text-shadow: 2px 2px 0 var(--inset); }
  .preview .lbls { text-align: right; } .preview .lbls b { color: var(--money); font-family: 'VT323'; font-size: 16px; }

  .opwrap { display: flex; align-items: center; gap: 12px; }
  .opmini { width: 64px; height: 44px; flex: none; border: var(--b) solid var(--ink); position: relative; overflow: hidden;
    background: linear-gradient(160deg, #3b1d5e, #b13e53 70%, #ef7d57); }
  .opmini .pane { position: absolute; inset: 8px; background: var(--panel); border: 2px solid var(--ink);
    display: grid; place-items: center; }
  .opmini .pane .n { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 11px; color: var(--money); }

  .stepper { display: inline-flex; border: var(--b) solid var(--ink); }
  .stepper button { width: 30px; background: var(--panel-2); border: none; color: var(--ink); font-family: 'Pixelify Sans'; font-weight: 700; }
  .stepper button:active { background: var(--money); color: var(--inset); }
  .stepper button:disabled { opacity: .45; cursor: not-allowed; }
  .stepper .val { width: 56px; display: grid; place-items: center; background: var(--inset); font-family: 'VT323'; font-size: 20px; color: var(--money); border-left: 2px solid var(--ink); border-right: 2px solid var(--ink); }

  .errline { font-family: 'DotGothic16'; font-size: 12px; color: var(--danger); padding: 2px 2px 0; }

  .footer { display: flex; gap: 10px; padding: 14px 16px; border-top: var(--b) solid var(--ink); background: var(--inset); }
  .footer .btn { flex: 1; justify-content: center; }
  .footer .btn.save { flex: 2; }
`;
