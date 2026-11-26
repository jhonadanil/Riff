import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./audio/midiSeq";
import "./audio/pluginSync";
import "./audio/trackFx";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
