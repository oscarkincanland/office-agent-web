import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import DesktopAgentPrototype from "./components/桌面端Agent原型.jsx";
import { ThemeProvider } from "./theme.jsx";
import "./styles.css";

const isDesktopPrototype = new URLSearchParams(window.location.search).get("prototype") === "desktop";

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    {isDesktopPrototype ? <DesktopAgentPrototype /> : <App />}
  </ThemeProvider>
);
