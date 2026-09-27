import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "./styles.css";
import App from "./App";
import { Providers } from "./providers";

if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const editable = target?.closest("input, textarea, [contenteditable='true']");
    const selected = (window.getSelection()?.toString() ?? "") !== "";
    if (!editable && !selected) event.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
