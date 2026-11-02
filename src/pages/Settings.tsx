import { useNavigate } from "react-router-dom";

import "../styles/global.css";
import "./dashboard.css";
import { useTheme } from "../lib/useTheme";
import { useTranslation } from "../lib/useTranslations.ts";

import SunIcon14px from "../assets/icons/sun-14px.svg";
import MoonIcon14px from "../assets/icons/moon-14px.svg";
import LogoIcon26px from "../assets/icons/logo-26px.svg";
import GoBackArrow21px from "../assets/icons/go-back-arrow-21px.svg";

function Settings() {
    const { theme, toggleTheme } = useTheme();
    const isDark = theme === "dark";
    const { language, setLanguage, t } = useTranslation();

    const navigate = useNavigate();
    return (
        <div>
            <div className="nav">
                <div className="brand-and-breadcrumb">
                    <div className="brand">
                        <img src={LogoIcon26px} alt="PhysicsGo logo" />
                    </div>
                    <h1>Terra</h1>
                    <div className="spacer"></div>
                    <h2>{t("settings.title")}</h2>
                </div>
                <div className="right-system-actions">
                    <button onClick={() => navigate("/dashboard")}>
                        <img src={GoBackArrow21px} alt="GoBackArrow21px"/>
                    </button>
                </div>
            </div>

            <div className="content-settings">
                <div className="language">
                    <div className="setting-row">
                        <div className="setting-row-text">
                            <h3>{t("settings.languageTitle")}</h3>
                            <p>{language === "nl" ? t("settings.dutchSelected") : t("settings.englishSelected")}</p>
                        </div>
                        <div
                            className="language-toggle"
                            role="radiogroup"
                            aria-label={t("settings.languageTitle")}
                            data-active={language}
                        >
                            <button
                                type="button"
                                className="language-toggle-option"
                                role="radio"
                                aria-checked={language === "nl"}
                                onClick={() => setLanguage("nl")}
                            >
                                NL
                            </button>
                            <button
                                type="button"
                                className="language-toggle-option"
                                role="radio"
                                aria-checked={language === "en"}
                                onClick={() => setLanguage("en")}
                            >
                                EN
                            </button>
                            <span className="language-toggle-thumb" aria-hidden="true"></span>
                        </div>
                    </div>
                </div>
                <div className="theme">
                    <div className="setting-row">
                        <div className="setting-row-text">
                            <h3>{t("settings.appearanceTitle")}</h3>
                            <p>{isDark ? t("settings.darkModeOn") : t("settings.lightModeOn")}</p>
                        </div>
                        <button
                            type="button"
                            className="theme-toggle"
                            role="switch"
                            aria-checked={isDark}
                            aria-label={t("settings.toggleDarkMode")}
                            onClick={toggleTheme}
                        >
                            <span className="theme-toggle-icon" aria-hidden="true">
                                <img src={SunIcon14px} alt="" />
                            </span>
                            <span className="theme-toggle-icon" aria-hidden="true">
                                <img src={MoonIcon14px} alt="" />
                            </span>
                            <span className="theme-toggle-thumb"></span>
                        </button>
                    </div>
                </div>

            </div>
        </div>
    )
}

export default Settings;