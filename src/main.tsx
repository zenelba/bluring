import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AccessGate from "./AccessGate";
import App from "./App";
import "./index.css";

// After a new Vercel deploy, cached HTML may reference removed JS chunks — reload once.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessGate>
      <App />
    </AccessGate>
  </StrictMode>,
);
