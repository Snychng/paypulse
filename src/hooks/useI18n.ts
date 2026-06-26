/**
 * useI18n — keep i18next's active language in sync with the user's setting (M7).
 * 'system' resolves to the OS/browser locale (zh* → zh, else en). Changing the
 * language in settings broadcasts a `state-changed`, useSettings refetches, and
 * every window re-renders in the new language.
 */
import { useEffect } from "react";

import i18n from "@/i18n";
import { resolveLanguage } from "@/shared/format";
import type { Language } from "@/shared/types";

export function useI18n(language: Language | undefined): void {
  useEffect(() => {
    void i18n.changeLanguage(resolveLanguage(language ?? "system"));
  }, [language]);
}
