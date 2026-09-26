import { HashRouter, Routes, Route } from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";

function App() {
    return (
        <HashRouter>
            <Routes>
                <Route path="/dashboard" element={< Dashboard />} />
                <Route path="/" element={< Dashboard />} />
                <Route path="/settings" element={<Settings />} />
            </Routes>
        </HashRouter>
    )
}

export default App;