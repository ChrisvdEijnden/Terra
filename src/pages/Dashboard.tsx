import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import "../styles/global.css";
import "./dashboard.css";

import Area from "../lib/CalculateArea.tsx";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import SettingsIcon21px from "../assets/icons/settings-21px.svg";
import EyedropperIcon21px from "../assets/icons/eyedropper-21px.svg";
import FolderOpen21px from "../assets/icons/folderopen-21px.svg";

function Dashboard() {
    const navigate = useNavigate();

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [hsvValue, setHsvValue] = useState(1);

    const handleFileChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];

            if (!file) return;
            if (!file.type.startsWith("image/")) return;

            const newImageUrl = URL.createObjectURL(file);

            setImageUrl(newImageUrl);

            event.target.value = "";
        },
        []
    );

    const openFilePicker = useCallback(() => {
        const input = fileInputRef.current;

        if (!input) return;
        input.click();
    }, []);

    useEffect(() => {
        if (!imageUrl) return;

        return () => {
            URL.revokeObjectURL(imageUrl);
        };
    }, [imageUrl]);

    return (
        <div>
            <div className="nav">
                <div className="brand-and-breadcrumb">
                    <div className="brand">
                        <img src={LogoIcon26px} alt="PhysicsGo logo" />
                    </div>

                    <h1>Terra</h1>

                    <div className="spacer"></div>

                    <h2>Dashboard</h2>
                </div>

                <div className="system-actions">
                    <div className="area">
                        <p>
                            Area: <strong><Area hsvValue={hsvValue} /> Ha</strong>
                        </p>
                    </div>

                    <div className="right-system-actions">
                        <button onClick={openFilePicker}>
                            <img src={FolderOpen21px} alt="Open image" />

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handleFileChange}
                                hidden
                            />
                        </button>
                        <button onClick={() => navigate("/settings")}>
                            <img src={SettingsIcon21px} alt="Settings" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="content-dashboard">
                <div
                    className="background"
                    style={{
                        backgroundImage: imageUrl ? `url("${imageUrl}")` : undefined,
                    }}
                />

                <div className="controls">
                    <div className="color-picker" id="color-picker">
                        <img src={EyedropperIcon21px} alt="Color picker" />
                    </div>

                    <div className="slider-container">
                        <input
                            type="range"
                            min="1"
                            max="50"
                            step="1"
                            className="slider"
                            id="hsvValue"
                            value={hsvValue}
                            onChange={(event) => setHsvValue(Number(event.target.value))}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Dashboard;