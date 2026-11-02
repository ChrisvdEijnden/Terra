import { useCallback } from "react";
import { useLanguage } from "./useLanguage";
import { translations, TranslationKey } from "./Translations.ts";

export function useTranslation() {
    const { language, setLanguage, toggleLanguage } = useLanguage();

    // Stable until the language changes, so it is safe in hook dependency lists
    const t = useCallback((key: TranslationKey, params?: Record<string, string | number>): string => {
        const str: string = translations[language][key] ?? translations.en[key] ?? key;
        if (!params) return str;
        // A replacer function, so a "$" in a value (a file name, say) is inserted literally
        return str.replace(/\{\{(\w+)\}\}/g, (match, name) => String(params[name] ?? match));
    }, [language]);

    return { t, language, setLanguage, toggleLanguage };
}