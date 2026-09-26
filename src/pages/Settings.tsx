import { useNavigate } from "react-router-dom";

import "../styles/global.css";
import "./dashboard.css";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import GoBackArrow21px from "../assets/icons/go-back-arrow-21px.svg";

function Settings() {
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
                    <h2>Settings</h2>
                </div>
                <div className="right-system-actions">
                    <button onClick={() => navigate("/dashboard")}>
                        <img src={GoBackArrow21px} alt="GoBackArrow21px"/>
                    </button>
                </div>
            </div>

            <div className="content-settings">

            </div>
        </div>
    )
}

export default Settings;