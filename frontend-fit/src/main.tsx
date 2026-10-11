import React from "react";
import ReactDOM from "react-dom/client";
// Только латиница и кириллица: полный набор начертаний утраивает CSS.
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/cyrillic-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/cyrillic-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/cyrillic-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/manrope/cyrillic-700.css";
import "@fontsource/manrope/latin-800.css";
import "@fontsource/manrope/cyrillic-800.css";
import App from "./App";
import "./styles.css";

// Оболочка должна открываться в зале без сети. Только по https: сервис-воркеру нужен защищённый адрес.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
