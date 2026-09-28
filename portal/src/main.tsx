import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "./install"; // 越早接住 beforeinstallprompt 越好
import { startI18n } from "./i18n";

startI18n(); // 英文模式：画面文字换成英文（中文模式不做事）

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
