import { useEffect, useState } from "react";
import Icon from "./Icon";

function useCountUp(value) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    if (typeof value !== "number" || !Number.isFinite(value)) { setDisplay(value); return undefined; }
    const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setDisplay(value); return undefined; }
    const from = typeof display === "number" ? display : 0;
    const started = performance.now();
    let frame;
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / 800);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(from + (value - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return typeof display === "number" ? new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(display) : display;
}

export default function KpiCard({ label, value, unit = "", hint, icon = "chart", tone = "blue", loading = false, error = "", retry }) {
  const shown = useCountUp(value);
  return <article className={`kpi-card tone-${tone} enter-card`}>
    <div className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon name={icon} size={17} /></span></div>
    {loading ? <span className="kpi-skeleton" aria-label={`Loading ${label}`} /> : error ? <strong className="kpi-error">Unavailable</strong> : <strong className="kpi-value">{shown}{unit && shown !== "-" ? <small> {unit}</small> : null}</strong>}
    <p>{error ? <>{error} {retry && <button className="inline-retry" onClick={retry}>Retry</button>}</> : hint}</p>
  </article>;
}
