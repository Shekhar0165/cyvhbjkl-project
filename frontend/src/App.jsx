import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAccuracy, fetchErrorDistribution, fetchEvolution, fetchForecast, fetchHorizon,
  fetchHealth, fetchHourOfDay, fetchMeta, fetchProcurementBacktest, fetchProcurementPlan,
} from "./api";
import Sidebar from "./layout/Sidebar";
import TopBar from "./layout/TopBar";
import Skeleton from "./ui/Skeleton";

const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const LegacyPages = lazy(() => import("./pages/LegacyPages.jsx"));

const JAN_START = "2026-01-01";
const JAN_END = "2026-01-31";
const JANUARY_DATES = Array.from({ length: 31 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`);
const PAGE_IDS = ["dashboard", "buy-plan", "forecast", "accuracy"];
const pageFromHash = () => {
  const hash = window.location.hash.slice(1);
  return PAGE_IDS.includes(hash) ? hash : "dashboard";
};
const DEMAND_STORAGE_KEY = "winddesk-demand-mw-v1";
const DEFAULT_DEMAND = Array(24).fill("30000");
function storedDemand() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMAND_STORAGE_KEY));
    return Array.isArray(saved) && saved.length === 24 ? saved.map(String) : DEFAULT_DEMAND;
  } catch { return DEFAULT_DEMAND; }
}

class PageErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <section className="render-error-card page-render-error" role="alert"><h2>This page could not render</h2><p>{this.state.error.message}</p><button className="button secondary" onClick={() => this.setState({ error: null })}>Try again</button></section>;
    return this.props.children;
  }
}

function ErrorBlock({ error, retry }) {
  return <div className="error-box" role="alert"><div><strong>We couldn't load this view.</strong><p>{error}</p></div><button className="button secondary" onClick={retry}>Try again</button></div>;
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [page, setPage] = useState(pageFromHash);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [decisionDate, setDecisionDate] = useState("2026-01-01");
  const [cutoff, setCutoff] = useState("10:00");
  const [rangeFrom, setRangeFrom] = useState(JAN_START);
  const [rangeTo, setRangeTo] = useState(JAN_END);
  const [forecast, setForecast] = useState(null);
  const [evolution, setEvolution] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [distribution, setDistribution] = useState(null);
  const [horizon, setHorizon] = useState(null);
  const [byHour, setByHour] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const viewAbortRef = useRef(null);
  const [metaError, setMetaError] = useState("");
  const [demand, setDemandState] = useState(storedDemand);
  const [demandMode, setDemandMode] = useState("flat");
  const [confidence, setConfidence] = useState(0.9);
  const [fullMonth, setFullMonth] = useState(false);
  const [plan, setPlan] = useState(null);
  const [backtestData, setBacktestData] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [backtestBusy, setBacktestBusy] = useState(false);
  const [backtestError, setBacktestError] = useState("");
  const [planError, setPlanError] = useState("");
  const planAbortRef = useRef(null);
  const backtestAbortRef = useRef(null);
  const setDemand = useCallback((values) => {
    setDemandState(values);
    try { localStorage.setItem(DEMAND_STORAGE_KEY, JSON.stringify(values)); } catch { /* Browser storage may be disabled. */ }
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const data = await fetchMeta();
      setMeta(data);
      fetchHealth().then(setHealth).catch(() => setHealth(null));
      setCutoff(data.default_cutoff_utc || "10:00");
      setDecisionDate((current) => JANUARY_DATES.includes(current) ? current : JAN_START);
      setRangeFrom((current) => JANUARY_DATES.includes(current) ? current : JAN_START);
      setRangeTo((current) => JANUARY_DATES.includes(current) ? current : JAN_END);
      setMetaError("");
    } catch (reason) { setMetaError(reason.message); }
  }, []);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, "", "#dashboard");
    const updatePage = () => setPage(pageFromHash());
    window.addEventListener("hashchange", updatePage);
    return () => window.removeEventListener("hashchange", updatePage);
  }, []);
  const navigate = useCallback((nextPage) => {
    if (!PAGE_IDS.includes(nextPage)) return;
    if (window.location.hash === `#${nextPage}`) setPage(nextPage);
    else window.location.hash = nextPage;
    setError("");
  }, []);

  const loadSelectedView = useCallback(async () => {
    if (!meta || !decisionDate || !rangeFrom || !rangeTo) return;
    viewAbortRef.current?.abort();
    const controller = new AbortController();
    viewAbortRef.current = controller;
    setBusy(true); setError("");
    try {
      if (page === "forecast") {
        const [forecastData, evolutionData] = await Promise.all([fetchForecast(decisionDate, cutoff, { signal: controller.signal }), fetchEvolution(decisionDate, cutoff, { signal: controller.signal })]);
        if (viewAbortRef.current === controller) { setForecast(forecastData); setEvolution(evolutionData); }
      } else if (page === "accuracy") {
        const [accuracyData, distributionData, horizonData, hourData] = await Promise.all([
          fetchAccuracy(rangeFrom, rangeTo, cutoff, { signal: controller.signal }), fetchErrorDistribution(rangeFrom, rangeTo, cutoff, { signal: controller.signal }),
          fetchHorizon(rangeFrom, rangeTo, { signal: controller.signal }), fetchHourOfDay(rangeFrom, rangeTo, cutoff, { signal: controller.signal }),
        ]);
        if (viewAbortRef.current === controller) { setAccuracy(accuracyData); setDistribution(distributionData); setHorizon(horizonData); setByHour(hourData); }
      }
    } catch (reason) { if (viewAbortRef.current === controller && !controller.signal.aborted) setError(reason.message); }
    finally { if (viewAbortRef.current === controller) { viewAbortRef.current = null; setBusy(false); } }
  }, [meta, page, decisionDate, cutoff, rangeFrom, rangeTo]);
  useEffect(() => () => { viewAbortRef.current?.abort(); viewAbortRef.current = null; }, [page, decisionDate, cutoff, rangeFrom, rangeTo]);
  useEffect(() => { if (page === "forecast" || page === "accuracy") loadSelectedView(); }, [loadSelectedView, page]);

  const calculatePlan = useCallback(async (demandValue, useFullMonth = fullMonth) => {
    planAbortRef.current?.abort();
    backtestAbortRef.current?.abort();
    const planController = new AbortController();
    const backtestController = new AbortController();
    planAbortRef.current = planController;
    backtestAbortRef.current = backtestController;
    setPlanBusy(true); setPlanError("");
    setBacktestBusy(true); setBacktestError("");
    void fetchProcurementBacktest(JAN_START, JAN_END, cutoff, confidence, 30000, { signal: backtestController.signal })
      .then((data) => { if (backtestAbortRef.current === backtestController) setBacktestData(data); })
      .catch((reason) => { if (backtestAbortRef.current === backtestController && !backtestController.signal.aborted) setBacktestError(reason.message); })
      .finally(() => {
        if (backtestAbortRef.current === backtestController) {
          backtestAbortRef.current = null;
          setBacktestBusy(false);
        }
      });
    try {
      const planData = await fetchProcurementPlan({ decision_date: decisionDate, cutoff, confidence, demand_mw: demandValue, use_full_month_stats: useFullMonth }, { signal: planController.signal });
      if (planAbortRef.current === planController) setPlan(planData);
    } catch (reason) {
      if (planAbortRef.current === planController && !planController.signal.aborted) setPlanError(reason.message);
    } finally {
      if (planAbortRef.current === planController) {
        planAbortRef.current = null;
        setPlanBusy(false);
      }
    }
  }, [decisionDate, cutoff, confidence, fullMonth]);
  useEffect(() => () => {
    const planController = planAbortRef.current;
    const backtestController = backtestAbortRef.current;
    planAbortRef.current = null;
    backtestAbortRef.current = null;
    planController?.abort();
    backtestController?.abort();
  }, []);
  useEffect(() => {
    planAbortRef.current?.abort();
    backtestAbortRef.current?.abort();
    planAbortRef.current = null;
    backtestAbortRef.current = null;
    setPlanBusy(false);
    setBacktestBusy(false);
  }, [decisionDate, cutoff, confidence, fullMonth, demand, demandMode]);

  const titles = { dashboard: "Dashboard", "buy-plan": "Buy plan", forecast: "Forecast", accuracy: "Accuracy" };
  const descriptions = {
    dashboard: "A concise view of wind performance and purchase risk for the selected decision date.",
    "buy-plan": "Translate the cutoff forecast and measured error into an hourly purchase plan using your demand input.",
    forecast: "See the wind outlook your team could have used before buying for the next delivery day.",
    accuracy: "Measure how far the decision-time outlook differed from metered wind generation.",
  };

  return <div className="app-shell">
    <Sidebar page={page} onNavigate={navigate} version={health?.version} mobileOpen={mobileOpen} closeMobile={() => setMobileOpen(false)} />
    <div className="workspace">
      <TopBar title={titles[page]} description={descriptions[page]} page={page} decisionDate={decisionDate} setDecisionDate={setDecisionDate} cutoff={cutoff} setCutoff={setCutoff} rangeFrom={rangeFrom} setRangeFrom={setRangeFrom} rangeTo={rangeTo} setRangeTo={setRangeTo} cutoffAssumption={meta?.default_cutoff_utc} onMenu={() => setMobileOpen(true)} />
      <main className="page-content" key={page}>
        {metaError && <ErrorBlock error={metaError} retry={loadMeta} />}
        {page === "dashboard" ? <PageErrorBoundary key={page}><Suspense fallback={<Skeleton kind="chart" />}><Dashboard decisionDate={decisionDate} cutoff={cutoff} onRetryPlan={() => navigate("buy-plan")} /></Suspense></PageErrorBoundary>
          : page === "buy-plan" ? <PageErrorBoundary key={page}><Suspense fallback={<Skeleton kind="chart" />}><div className="content-stack page-enter"><LegacyPages page="buy-plan" result={plan} backtest={backtestData} demand={demand} setDemand={setDemand} mode={demandMode} setMode={setDemandMode} confidence={confidence} setConfidence={setConfidence} fullMonth={fullMonth} setFullMonth={setFullMonth} busy={planBusy} error={planError} retry={() => calculatePlan(demandMode === "flat" ? Number(demand[0]) : demand.map(Number))} calculate={calculatePlan} backtestBusy={backtestBusy} backtestError={backtestError} /></div></Suspense></PageErrorBoundary>
            : page === "forecast" ? <PageErrorBoundary key={page}><Suspense fallback={<Skeleton kind="chart" />}><div className="content-stack page-enter"><LegacyPages page="forecast" result={forecast} evolution={evolution} busy={busy || !meta} error={error} retry={loadSelectedView} /></div></Suspense></PageErrorBoundary>
              : <PageErrorBoundary key={page}><Suspense fallback={<Skeleton kind="chart" />}><div className="content-stack page-enter"><LegacyPages page="accuracy" accuracy={accuracy} distribution={distribution} horizon={horizon} byHour={byHour} busy={busy || !meta} error={error} retry={loadSelectedView} /></div></Suspense></PageErrorBoundary>}
        <footer className="footer"><span>WindDesk | UK national wind only | Times in UTC | Units in MW</span><a href="http://localhost:8000/docs" target="_blank" rel="noreferrer">API documentation</a></footer>
      </main>
    </div>
  </div>;
}
