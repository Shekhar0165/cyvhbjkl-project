import { useEffect, useState } from "react";
import Icon from "../ui/Icon";

const items = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "buy-plan", label: "Buy plan", icon: "plan" },
  { id: "forecast", label: "Forecast", icon: "forecast" },
  { id: "accuracy", label: "Accuracy", icon: "accuracy" },
];

export default function Sidebar({ page, onNavigate, version, mobileOpen, closeMobile }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("winddesk-sidebar-collapsed") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("winddesk-sidebar-collapsed", String(collapsed)); } catch { /* Storage may be unavailable. */ }
  }, [collapsed]);
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") closeMobile(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  return <>
    {mobileOpen && <button className="drawer-scrim" aria-label="Close navigation" onClick={closeMobile} />}
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-open" : ""}`} aria-label="Main navigation">
      <div className="sidebar-brand"><span className="brand-mark"><Icon name="wind" size={21} /></span><span className="brand-copy"><strong>WindDesk</strong><small>Wind decision intelligence</small></span></div>
      <nav className="side-nav" aria-label="Main pages" style={{ "--active-index": items.findIndex((item) => item.id === page) }}>
        <span className="active-rail" aria-hidden="true" />
        {items.map((item) => <a key={item.id} href={`#${item.id}`} className={`nav-item${page === item.id ? " active" : ""}`} aria-current={page === item.id ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate(item.id); closeMobile(); }} title={collapsed ? item.label : undefined}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </a>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="source-note"><span className="source-dot" /><span>Data: Elexon BMRS<br />January 2026</span></div>
        <div className="version-note">Version {version || "-"}</div>
        <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={collapsed ? "expand" : "collapse"} /><span>{collapsed ? "Expand" : "Collapse"}</span>
        </button>
      </div>
    </aside>
  </>;
}
