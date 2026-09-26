import { useNavigate } from "react-router-dom";

import "../styles/global.css";
import "./dashboard.css";

import Area from "../lib/CalculateArea.tsx";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import SettingsIcon21px from "../assets/icons/settings-21px.svg";
import EyedropperIcon21px from "../assets/icons/eyedropper-21px.svg";

function Dashboard() {
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
                    <h2>Dashboard</h2>
                </div>
                <div className="system-actions">
                    <div className="area">
                        <p>Area: <strong>{ Area } Ha</strong></p>
                    </div>
                    <div className="right-system-actions">
                        <button onClick={() => navigate("/settings")}>
                            <img src={SettingsIcon21px} alt="SettingsIcon21px"/>
                        </button>
                    </div>
                </div>
            </div>

            <div className="content-dashboard">
                <div className="controls">
                    <div className="color-picker">
                        <img src={EyedropperIcon21px} alt="EyedropperIcon21px"/>
                    </div>
                    <div className="slider-container">
                        <input type="range" min="1" max="50" step="any" className="slider" id="hsvValue"/>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Dashboard;