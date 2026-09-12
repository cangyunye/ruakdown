import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// No StrictMode: dev double-invoked effects would double IPC side effects
// (watch_folder, config restore) on startup.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
