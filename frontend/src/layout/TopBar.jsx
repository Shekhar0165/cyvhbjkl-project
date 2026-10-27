import { useState } from "react";
import Icon from "../ui/Icon";

const ASSUMPTION_DISMISSED_KEY = "winddesk-cutoff-assumption-dismissed-v1";
function readAssumptionDismissed() {
  try { return localStorage.getItem(ASSUMPTION_DISMISSED_KEY) === "true"; } catch { return false; }
}

export default function TopBar({ title, description, page, decisionDate, setDecisionDate, cutoff, setCutoff, rangeFrom, setRangeFrom, rangeTo, setRangeTo, cutoffAssumption, onMenu }) {
  const [showAssumption, setShowAssumption] = useState(() => !readAssumptionDismissed());
  const dates = Array.from({ length: 31 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
  return <header className="topbar-shell">
    <div className="topbar-heading"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={onMenu}><Icon name="menu" /></button><div><h1>{title}</h1><p>{description}</p></div></div>
    <div className="topbar-controls">
      <label><span>Decision date</span><select value={decisionDate} onChange={(event) => setDecisionDate(event.target.value)}>{dates.map((day) => <option key={day}>{day}</option>)}</select></label>
      <label><span>Cutoff (UTC)</span><input type="time" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label>
      {page === "accuracy" && <>
        <label><span>Range start</span><select value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)}>{dates.map((day) => <option key={day}>{day}</option>)}</select></label>
        <label><span>Range end</span><select value={rangeTo} onChange={(event) => setRangeTo(event.target.value)}>{dates.map((day) => <option key={day}>{day}</option>)}</select></label>
      </>}
    </div>
    {showAssumption ? <div className="cutoff-note"><Icon name="info" size={15} /><span><strong>Cutoff assumption:</strong> {cutoffAssumption || "10:00"} UTC is configurable; the actual market gate closure time has not been verified.</span><button aria-label="Dismiss cutoff assumption" onClick={() => { setShowAssumption(false); try { localStorage.setItem(ASSUMPTION_DISMISSED_KEY, "true"); } catch { /* Storage may be unavailable. */ } }}><Icon name="close" size={15} /></button></div>
      : <div className="cutoff-note compact"><button className="assumption-info" aria-label="Cutoff assumption information" title={`Cutoff assumption: ${cutoffAssumption || "10:00"} UTC is configurable; the actual market gate closure time has not been verified.`}><Icon name="info" size={15} /></button><span>Cutoff assumption</span></div>}
  </header>;
}
