import { HashRouter, Routes, Route } from "react-router-dom";

import Dashboard from "./pages/Dashboard";

// One page: Settings is a menu on the Dashboard, so measuring is never interrupted.
function App() {
    return (
        <HashRouter>
            <Routes>
                <Route path="*" element={<Dashboard />} />
            </Routes>
        </HashRouter>
    );
}

export default App;
