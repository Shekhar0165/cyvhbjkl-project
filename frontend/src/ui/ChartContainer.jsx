import { useEffect, useRef } from "react";
import { ResponsiveContainer } from "recharts";

// Keep SVG colors as concrete values; SVG presentation attributes should not
// depend on CSS custom-property resolution inside an embedded chart.
export const chartColors = Object.freeze({
  forecast: "#174ea6",
  forecastFill: "#dbe8fb",
  actual: "#45556b",
  error: "#b5473c",
  errorFill: "#f5deda",
  warning: "#a66b16",
  success: "#18704f",
  grid: "#e9edf3",
  axis: "#68778d",
  border: "#c4cfdd",
});

export default function ChartContainer({ name, height = 320, className = "", children }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !containerRef.current) return undefined;
    const element = containerRef.current;
    let warned = false;
    let frame = 0;
    const inspectSize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height: measuredHeight } = element.getBoundingClientRect();
        if (!warned && (!width || !measuredHeight)) {
          warned = true;
          console.warn(`[WindDesk chart] "${name}" has a zero-sized container (${width} x ${measuredHeight}).`);
        }
      });
    };
    const observer = new ResizeObserver(inspectSize);
    observer.observe(element);
    inspectSize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [name]);

  return (
    <figure
      ref={containerRef}
      className={`chart-container ${className}`.trim()}
      style={{ "--chart-height": `${height}px` }}
      aria-label={name}
    >
      <figcaption className="sr-only">{name}. Chart values use the units and time labels shown on the axes.</figcaption>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </figure>
  );
}
