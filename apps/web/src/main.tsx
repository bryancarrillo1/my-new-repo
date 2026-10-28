// Global styles first: component CSS modules must load after them so their
// rules win ties in specificity (e.g. a highlighted .stat over the base .card).
import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
