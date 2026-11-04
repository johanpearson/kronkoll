import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import { applyStoredTheme } from "./theme.ts";

applyStoredTheme();
// Bara i produktionsbygget, och efter att sidan laddat så att den inte konkurrerar med första bilden.
if (import.meta.env.PROD) {
  window.addEventListener("load", () => {
    registerServiceWorker();
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Elementet #root saknas i index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
