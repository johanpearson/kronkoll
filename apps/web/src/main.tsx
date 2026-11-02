import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import { App } from "./App.tsx";
import { applyStoredTheme } from "./theme.ts";

applyStoredTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Elementet #root saknas i index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
