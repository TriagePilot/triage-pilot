import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "@triagepilot/ui/styles.css";

createRoot(document.getElementById("root")!).render(<App />);
