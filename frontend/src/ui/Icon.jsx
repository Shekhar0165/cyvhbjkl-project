const paths = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="11" width="7" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" /></>,
  plan: <><path d="M4 7h16M6 3v4m12-4v4M5 11h14v9H5z" /><path d="m8 15 2 2 5-5" /></>,
  forecast: <><path d="M3 17 9 11l4 4 8-9" /><path d="M15 6h6v6" /></>,
  accuracy: <><path d="M4 19V5m0 14h17" /><path d="M7 15l4-5 3 2 6-7" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  collapse: <><path d="m15 18-6-6 6-6" /></>,
  expand: <><path d="m9 18 6-6-6-6" /></>,
  wind: <><path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a2 2 0 1 1-2 2M4 16h10a3 3 0 1 1-3 3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 17v4h14v-4" /></>,
  chart: <><path d="M3 3v18h18" /><path d="m7 14 4-4 4 3 5-7" /></>,
  gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 14 4-4M6 18h12" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

export default function Icon({ name, size = 18, className = "" }) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.chart}</svg>;
}
