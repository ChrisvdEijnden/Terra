// Language and appearance, in a menu under the gear button (the Dashboard stays as it is).
import { useTheme } from "../lib/useTheme";
import { useTranslation } from "../lib/useTranslations.ts";
import type { Language } from "../lib/useLanguage";
import { maskIcon, onRadioKeys } from "../lib/ui.ts";

import SunIcon14px from "../assets/icons/sun-14px.svg";
import MoonIcon14px from "../assets/icons/moon-14px.svg";

const LANGUAGES: readonly Language[] = ["nl", "en"];

function SettingsMenu({ closing }: { closing: boolean }) {
    const { theme, toggleTheme } = useTheme();
    const isDark = theme === "dark";
    const { language, setLanguage, t } = useTranslation();

    return (
        <div
            className={`settings-popover popover${closing ? " popover-exit" : ""}`}
            role="dialog"
            aria-label={t("settings.title")}
        >
            <div className="popover-header">{t("settings.title")}</div>
            <div className="setting-row">
                <span className="setting-label">{t("settings.languageTitle")}</span>
                <div
                    className="language-toggle"
                    role="radiogroup"
                    aria-label={t("settings.languageTitle")}
                    data-active={language}
                    onKeyDown={(e) => onRadioKeys(e, LANGUAGES, language, () => true, setLanguage)}
                >
                    {LANGUAGES.map((lang) => (
                        <button
                            key={lang}
                            type="button"
                            className="language-toggle-option"
                            role="radio"
                            aria-checked={language === lang}
                            tabIndex={language === lang ? 0 : -1}
                            onClick={() => setLanguage(lang)}
                        >
                            {lang.toUpperCase()}
                        </button>
                    ))}
                    <span className="language-toggle-thumb" aria-hidden="true"></span>
                </div>
            </div>
            <div className="setting-row">
                <span className="setting-label">{t("settings.appearanceTitle")}</span>
                <button
                    type="button"
                    className="theme-toggle"
                    role="switch"
                    aria-checked={isDark}
                    aria-label={t("settings.toggleDarkMode")}
                    onClick={toggleTheme}
                >
                    <span className="theme-toggle-icon" aria-hidden="true">
                        <span className="icon-mask" style={maskIcon(SunIcon14px)} />
                    </span>
                    <span className="theme-toggle-icon" aria-hidden="true">
                        <span className="icon-mask" style={maskIcon(MoonIcon14px)} />
                    </span>
                    <span className="theme-toggle-thumb"></span>
                </button>
            </div>
        </div>
    );
}

export default SettingsMenu;
