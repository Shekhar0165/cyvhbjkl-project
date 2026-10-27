import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

export default function CsvButton({ onDownload, label = "Download CSV" }) {
  const [state, setState] = useState("idle");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const download = () => {
    if (state === "preparing") return;
    clearTimeout(timer.current);
    setState("preparing");
    timer.current = setTimeout(() => {
      try {
        onDownload();
        setState("success");
        timer.current = setTimeout(() => setState("idle"), 1800);
      } catch {
        setState("error");
        timer.current = setTimeout(() => setState("idle"), 3000);
      }
    }, 140);
  };
  const currentLabel = state === "preparing" ? "Preparing..." : state === "success" ? "Downloaded" : state === "error" ? "Download failed" : label;
  return <button className={`button secondary csv-button csv-${state}`} onClick={download} disabled={state === "preparing"} aria-label={currentLabel}>
    {state === "preparing" ? <span className="spinner" aria-hidden="true" /> : <Icon name={state === "success" ? "check" : "download"} className="csv-icon" />}{currentLabel}
  </button>;
}
