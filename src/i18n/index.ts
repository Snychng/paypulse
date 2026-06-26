/**
 * i18next setup (PLAN §7, M7). One namespace per window — each window owns its
 * own locale files, so the four windows can be translated independently without
 * touching a shared JSON (no merge conflicts). Language is driven by settings via
 * `useI18n`; currency follows language separately (D2, see shared/format.ts).
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import mainZh from "./locales/main.zh.json";
import mainEn from "./locales/main.en.json";
import miniZh from "./locales/mini.zh.json";
import miniEn from "./locales/mini.en.json";
import settingsZh from "./locales/settings.zh.json";
import settingsEn from "./locales/settings.en.json";
import popoverZh from "./locales/popover.zh.json";
import popoverEn from "./locales/popover.en.json";

const resources = {
  zh: {
    main: mainZh,
    mini: miniZh,
    settings: settingsZh,
    popover: popoverZh,
  },
  en: {
    main: mainEn,
    mini: miniEn,
    settings: settingsEn,
    popover: popoverEn,
  },
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: "zh",
    fallbackLng: "zh",
    ns: ["main", "mini", "settings", "popover"],
    defaultNS: "main",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18n;
