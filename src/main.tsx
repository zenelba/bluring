import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AccessGate from "./AccessGate";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessGate>
      <App />
    </AccessGate>
  </StrictMode>,
);
