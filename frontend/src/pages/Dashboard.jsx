import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ReferenceLine, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  fetchAccuracy, fetchErrorDistribution, fetchForecast, fetchHorizon,
  fetchHourOfDay, fetchProcurementBacktest,
} from "../api";
import Card from "../ui/Card";
import CsvButton from "../ui/CsvButton";
import Icon from "../ui/Icon";
import KpiCard from "../ui/KpiCard";
import ChartContainer, { chartColors } from "../ui/ChartContainer";
import Skeleton from "../ui/Skeleton";
import Tabs from "../ui/Tabs";

const JAN_START = "2026-01-01";
const JAN_END = "2026-01-31";
const fmt = (value, digits = 1) => value == null ? "-" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(value);
const timeLabel = (value) => value ? value.slice(11, 16) : "-";
const dateTimeLabel = (value) => value ? `${value.slice(5, 10)} ${timeLabel(value)}` : "-";
const animationsEnabled = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

function useResource(key, load) {
  const loadRef = useRef(load);
  const [retryIndex, setRetryIndex] = useState(0);
  const [state, setState] = useState({ data: null, loading: true, error: "" });
  loadRef.current = load;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ data: null, loading: true, error: "" });
    loadRef.current(controller.signal).then((data) => {
      if (active) setState({ data, loading: false, error: "" });
    }).catch((error) => {
      if (active && !controller.signal.aborted) setState({ data: null, loading: false, error: error.message });
    });
    return () => { active = false; controller.abort(); };
  }, [key, retryIndex]);
  return { ...state, retry: () => setRetryIndex((value) => value + 1) };
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.filter((item) => item.value != null).map((item) => <p key={item.dataKey}><i style={{ background: item.color }} />{item.name}: {fmt(item.value)} MW</p>)}</div>;
}

function WidgetState({ loading, error, retry, children, type = "chart" }) {
  if (loading) return <Skeleton kind={type} />;
  if (error) return <div className="widget-error" role="alert"><p>{error}</p><button className="button secondary" onClick={retry}>Try again</button></div>;
  return children;
}

function downloadForecastCsv(rows) {
  const columns = ["start_time", "forecast_mw", "publish_time", "hours_ahead", "actual_mw"];
  const escapeCsvCell = (value) => {
    if (value == null) return "";
    const raw = String(value).replace(/\r?\n/g, " ");
    return /[",]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  const text = [columns.join(","), ...rows.map((row) => columns.map((key) => escapeCsvCell(row[key])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = "winddesk-forecast.csv"; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ChartFrame({ data, dataKey = "label", children, ariaLabel }) {
  return <ChartContainer name={ariaLabel} height={320} className="dashboard-chart">
    <ComposedChart data={data} margin={{ top: 12, right: 18, bottom: 16, left: 6 }}>
      <CartesianGrid stroke={chartColors.grid} vertical={false} />
      <XAxis dataKey={dataKey} minTickGap={25} tick={{ fill: chartColors.axis, fontSize: 11 }} label={{ value: "Hour UTC", position: "insideBottom", offset: -10, fill: chartColors.axis }} />
      <YAxis width={70} tick={{ fill: chartColors.axis, fontSize: 11 }} label={{ value: "MW", angle: -90, position: "insideLeft", fill: chartColors.axis }} />
      <Tooltip content={<ChartTip />} /><Legend />{children}
    </ComposedChart>
  </ChartContainer>;
}

function ErrorPanel({ distribution, hourData, distributionResource, hourResource }) {
  const hourRows = hourData?.data || [];
  return <div className="dashboard-grid two">
    <Card title="Error distribution" description="See how often decision-time forecasts missed by each amount.">
      <WidgetState {...distributionResource} type="chart">
        {distribution?.data?.length ? <ChartContainer name="Error distribution" height={320} className="dashboard-chart"><BarChart data={distribution.data} margin={{ bottom: 14 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="from_mw" tickFormatter={fmt} label={{ value: "Error (MW)", position: "insideBottom", offset: -8 }} /><YAxis allowDecimals={false} label={{ value: "Hours", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value, _name, item) => [value, `${fmt(item.payload.from_mw)} to ${fmt(item.payload.to_mw)} MW`]} /><Legend /><Bar dataKey="count" name="Hourly observations" fill={chartColors.forecast} radius={[4, 4, 0, 0]} isAnimationActive={animationsEnabled()} animationDuration={760} /></BarChart></ChartContainer> : <div className="empty-state">No error distribution is available for this range.</div>}
        {distribution && <div className="percentile-row"><span>P5 <b>{fmt(distribution.p5_mw)} MW</b></span><span>Median <b>{fmt(distribution.p50_mw)} MW</b></span><span>P95 <b>{fmt(distribution.p95_mw)} MW</b></span></div>}
      </WidgetState>
    </Card>
    <Card title="Average error by hour" description="Signed bias above zero means over-forecast wind; below zero means under-forecast.">
      <WidgetState {...hourResource} type="chart">
        {hourRows.length ? <ChartContainer name="Average error by hour" height={320} className="dashboard-chart"><BarChart data={hourRows.map((row) => ({ ...row, over: Math.max(row.bias_mw || 0, 0), under: Math.min(row.bias_mw || 0, 0) }))} margin={{ bottom: 14 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><ReferenceLine y={0} stroke={chartColors.border} /><XAxis dataKey="hour_utc" tickFormatter={(value) => `${String(value).padStart(2, "0")}:00`} label={{ value: "Hour UTC", position: "insideBottom", offset: -8 }} /><YAxis label={{ value: "Bias (MW)", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value) => `${fmt(value)} MW`} /><Legend /><Bar dataKey="over" name="Over-forecast" fill={chartColors.warning} isAnimationActive={animationsEnabled()} animationDuration={760} /><Bar dataKey="under" name="Under-forecast" fill={chartColors.actual} isAnimationActive={animationsEnabled()} animationDuration={760} /></BarChart></ChartContainer> : <div className="empty-state">No hourly error data is available.</div>}
        {hourRows.length > 0 && <div className="table-scroll"><table><thead><tr><th>Hour UTC</th><th>MAE (MW)</th><th>Bias (MW)</th></tr></thead><tbody>{hourRows.map((row) => <tr key={row.hour_utc}><td>{`${String(row.hour_utc).padStart(2, "0")}:00`}</td><td>{fmt(row.mae_mw)}</td><td>{fmt(row.bias_mw)}</td></tr>)}</tbody></table></div>}
      </WidgetState>
    </Card>
  </div>;
}

export default function Dashboard({ decisionDate, cutoff, onRetryPlan }) {
  const forecast = useResource(`forecast:${decisionDate}:${cutoff}`, (signal) => fetchForecast(decisionDate, cutoff, { signal }));
  const accuracy = useResource(`accuracy:${JAN_START}:${JAN_END}:${cutoff}`, (signal) => fetchAccuracy(JAN_START, JAN_END, cutoff, { signal }));
  const distribution = useResource(`distribution:${JAN_START}:${JAN_END}:${cutoff}`, (signal) => fetchErrorDistribution(JAN_START, JAN_END, cutoff, { signal }));
  const horizon = useResource(`horizon:${JAN_START}:${JAN_END}`, (signal) => fetchHorizon(JAN_START, JAN_END, { signal }));
  const hour = useResource(`hour:${JAN_START}:${JAN_END}:${cutoff}`, (signal) => fetchHourOfDay(JAN_START, JAN_END, cutoff, { signal }));
  const backtest = useResource(`backtest:${cutoff}`, (signal) => fetchProcurementBacktest(JAN_START, "2026-01-30", cutoff, 0.9, 30000, { signal }));
  const [panel, setPanel] = useState("month");

  const dailyData = useMemo(() => (forecast.data?.points || []).map((row) => ({ ...row, label: timeLabel(row.start_time), forecast: row.forecast_mw, actual: row.actual_mw })), [forecast.data]);
  const monthData = useMemo(() => (accuracy.data?.series || []).map((row) => ({ ...row, label: dateTimeLabel(row.start_time), forecast: row.forecast_mw, actual: row.actual_mw })), [accuracy.data]);
  const coverage = useMemo(() => {
    const counts = new Map();
    (accuracy.data?.series || []).forEach((row) => {
      if (row.forecast_mw == null || row.actual_mw == null) return;
      const delivery = new Date(row.start_time);
      delivery.setUTCDate(delivery.getUTCDate() - 1);
      const day = delivery.toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) || 0) + 1);
    });
    return [...counts.values()].filter((count) => count === 24).length;
  }, [accuracy.data]);
  const hourBars = useMemo(() => (hour.data?.data || []).map((row) => ({ ...row, over: Math.max(row.bias_mw || 0, 0), under: Math.min(row.bias_mw || 0, 0) })), [hour.data]);
  const tabs = [
    { id: "month", label: "Forecast vs actual (month)" },
    { id: "errors", label: "Error analysis" },
    { id: "backtest", label: "Backtest" },
    { id: "table", label: "Data table" },
  ];
  const strategyNames = { naive: "Naive", bias_adjusted: "Bias-adjusted", recommended: "Risk-adjusted" };

  return <div className="page-flow page-enter" key={`${decisionDate}-${cutoff}`}>
    <div className="dashboard-intro"><div><span className="eyebrow">NATIONAL WIND GENERATION</span><h2>Decision overview</h2><p>Forecast performance and purchase risk for decision date {decisionDate}; delivery is the following day.</p></div><button className="button primary" onClick={onRetryPlan}>Open buy plan</button></div>
    <div className="kpi-grid">
      <KpiCard label="Mean absolute error" value={accuracy.data?.mae_mw ?? "-"} unit="MW" icon="accuracy" hint="Average forecast miss" loading={accuracy.loading} error={accuracy.error} retry={accuracy.retry} />
      <KpiCard label="Forecast bias" value={accuracy.data?.bias_mw ?? "-"} unit="MW" icon="chart" tone={(accuracy.data?.bias_mw || 0) >= 0 ? "amber" : "green"} hint="Positive means over-forecast" loading={accuracy.loading} error={accuracy.error} retry={accuracy.retry} />
      <KpiCard label="Root mean square error" value={accuracy.data?.rmse_mw ?? "-"} unit="MW" icon="gauge" hint="Larger misses count more" loading={accuracy.loading} error={accuracy.error} retry={accuracy.retry} />
      <KpiCard label="Mean absolute percentage error" value={accuracy.data?.mape_percent ?? "-"} unit="%" icon="layers" hint="Actuals under 1 MW excluded" loading={accuracy.loading} error={accuracy.error} retry={accuracy.retry} />
      <KpiCard label="Complete decision dates" value={accuracy.loading ? "-" : coverage} unit="of 31" icon="clock" tone="green" hint="24 matched forecast and actual hours" loading={accuracy.loading} error={accuracy.error} retry={accuracy.retry} />
      <KpiCard label="Average wind forecast" value={forecast.data?.summary?.average_mw ?? "-"} unit="MW" icon="wind" hint={`Published ${forecast.data?.summary?.latest_publish_time ? `${timeLabel(forecast.data.summary.latest_publish_time)} UTC` : "for selected cutoff"}`} loading={forecast.loading} error={forecast.error} retry={forecast.retry} />
    </div>

    <div className="dashboard-grid charts-grid">
      <Card title="Forecast vs actual" description={`Selected delivery day: ${forecast.data?.delivery_date || "-"}. The dashed line is actual generation.`} className="chart-card-main">
        <WidgetState loading={forecast.loading} error={forecast.error} retry={forecast.retry}>
          {forecast.data?.data_available && dailyData.length ? <ChartFrame data={dailyData} ariaLabel="Hourly wind forecast and actual generation for the selected delivery day"><Area dataKey="forecast" name="Wind forecast" stroke={chartColors.forecast} fill={chartColors.forecastFill} fillOpacity={1} isAnimationActive={animationsEnabled()} animationDuration={800} /><Line dataKey="actual" name="Actual wind" stroke={chartColors.actual} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={animationsEnabled()} animationDuration={800} /></ChartFrame> : <div className="empty-state">{forecast.data?.message || "No forecast data is available for this decision date."}</div>}
        </WidgetState>
      </Card>
      <Card title="Error by forecast lead time" description="Mean absolute error across all genuine forecast revisions.">
        <WidgetState {...horizon}>
          {horizon.data?.data?.length ? <ChartContainer name="Error by forecast lead time" height={320} className="dashboard-chart"><BarChart data={horizon.data.data} margin={{ bottom: 16 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="horizon" label={{ value: "Lead time", position: "insideBottom", offset: -8 }} /><YAxis label={{ value: "MAE (MW)", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value) => `${fmt(value)} MW`} /><Legend /><Bar dataKey="mae_mw" name="MAE" fill={chartColors.forecast} radius={[4, 4, 0, 0]} isAnimationActive={animationsEnabled()} animationDuration={800} /></BarChart></ChartContainer> : <div className="empty-state">No horizon data available.</div>}
        </WidgetState>
      </Card>
      <Card title="Average error by hour" description="Positive bars indicate over-forecast wind; negative bars indicate under-forecast.">
        <WidgetState {...hour}>
          {hourBars.length ? <ChartContainer name="Average error by hour" height={320} className="dashboard-chart"><BarChart data={hourBars} margin={{ bottom: 16 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><ReferenceLine y={0} stroke={chartColors.border} /><XAxis dataKey="hour_utc" tickFormatter={(value) => `${String(value).padStart(2, "0")}:00`} label={{ value: "Hour UTC", position: "insideBottom", offset: -8 }} /><YAxis label={{ value: "Bias (MW)", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value) => `${fmt(value)} MW`} /><Legend /><Bar dataKey="over" name="Over-forecast" fill={chartColors.warning} isAnimationActive={animationsEnabled()} animationDuration={800} /><Bar dataKey="under" name="Under-forecast" fill={chartColors.actual} isAnimationActive={animationsEnabled()} animationDuration={800} /></BarChart></ChartContainer> : <div className="empty-state">No hourly error data available.</div>}
        </WidgetState>
      </Card>
    </div>

    <div className="dashboard-grid bottom-grid">
      <Card title="Error distribution" description="Frequency of forecast-minus-actual errors; percentiles are shown below.">
        <WidgetState {...distribution}>
        {distribution.data?.data?.length ? <><ChartContainer name="Error distribution" height={240} className="dashboard-chart compact"><BarChart data={distribution.data.data} margin={{ bottom: 14 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="from_mw" tickFormatter={fmt} label={{ value: "Error (MW)", position: "insideBottom", offset: -8 }} /><YAxis allowDecimals={false} label={{ value: "Hours", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value, _name, item) => [value, `${fmt(item.payload.from_mw)} to ${fmt(item.payload.to_mw)} MW`]} /><Legend /><Bar dataKey="count" name="Observations" fill={chartColors.forecast} radius={[4, 4, 0, 0]} isAnimationActive={animationsEnabled()} animationDuration={800} /></BarChart></ChartContainer><div className="percentile-row"><span>P5 <b>{fmt(distribution.data.p5_mw)} MW</b></span><span>P50 <b>{fmt(distribution.data.p50_mw)} MW</b></span><span>P95 <b>{fmt(distribution.data.p95_mw)} MW</b></span></div></> : <div className="empty-state">No error distribution available.</div>}
        </WidgetState>
      </Card>
      <Card title="Walk-forward backtest" description="Recommended purchase coverage versus the 90% target; amounts depend on the 30,000 MW placeholder demand.">
        <WidgetState {...backtest} type="metric">
          {backtest.data && <><div className="coverage-meter"><div className="coverage-meter-label"><strong>{fmt((backtest.data.coverage || 0) * 100)}%</strong><span>Target {fmt(backtest.data.target_coverage * 100, 0)}%</span></div><div className="coverage-track"><span style={{ width: `${Math.min(100, (backtest.data.coverage || 0) * 100)}%` }} /></div></div><div className="backtest-mini"><span>{backtest.data.n_days_evaluated} days evaluated</span><span>Recommended shortfall <b>{fmt(backtest.data.strategies?.recommended?.total_shortfall_mwh)} MWh</b></span><span>Recommended surplus <b>{fmt(backtest.data.strategies?.recommended?.total_surplus_mwh)} MWh</b></span></div><p className="muted-caption">With flat demand, coverage depends on wind errors. The demand assumption affects shortfall and surplus.</p></>}
        </WidgetState>
      </Card>
    </div>

    <Card className="dashboard-tabs-card">
      <Tabs items={tabs} value={panel} onChange={setPanel} label="Dashboard detail panels" />
      <div className="tab-panel page-enter" key={panel} role="tabpanel" id={`panel-${panel}`} aria-labelledby={`tab-${panel}`}>
        {panel === "month" && <>
          <div className="inner-heading"><h3>Forecast vs actual (month)</h3><p>All matched hourly delivery periods in January; points use the decision-time cutoff.</p></div>
          <WidgetState {...accuracy}>
            {monthData.length ? <ChartFrame data={monthData} ariaLabel="Forecast and actual wind generation for January 2026"><Area dataKey="forecast" name="Wind forecast" stroke={chartColors.forecast} fill={chartColors.forecastFill} fillOpacity={1} isAnimationActive={animationsEnabled()} animationDuration={800} /><Line dataKey="actual" name="Actual wind" stroke={chartColors.actual} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={animationsEnabled()} animationDuration={800} /></ChartFrame> : <div className="empty-state">No matched forecast and actual data in this range.</div>}
          </WidgetState>
        </>}
        {panel === "errors" && <><div className="inner-heading"><h3>Error analysis</h3><p>Review the spread of forecast errors and hourly bias.</p></div><ErrorPanel distribution={distribution.data} hourData={hour.data} distributionResource={distribution} hourResource={hour} /></>}
        {panel === "backtest" && <><div className="inner-heading"><h3>Backtest results</h3><p>Walk-forward calibration uses only history available by each decision date. Flat demand assumption: 30,000 MW.</p></div><WidgetState {...backtest} type="table">{backtest.data && <div className="table-scroll"><table><thead><tr><th>Strategy</th><th>Shortfall total (MWh)</th><th>Shortfall avg/day (MWh)</th><th>Surplus total (MWh)</th><th>Surplus avg/day (MWh)</th></tr></thead><tbody>{Object.entries(backtest.data.strategies || {}).map(([name, row]) => <tr key={name}><td>{strategyNames[name] || name}</td><td>{fmt(row.total_shortfall_mwh)}</td><td>{fmt(row.average_shortfall_mwh_per_day)}</td><td>{fmt(row.total_surplus_mwh)}</td><td>{fmt(row.average_surplus_mwh_per_day)}</td></tr>)}</tbody></table></div>}</WidgetState></>}
        {panel === "table" && <><div className="inner-heading"><h3>Delivery-day data table</h3><p>Selected cutoff forecast and hourly actual wind for {forecast.data?.delivery_date || "the selected delivery day"}.</p></div><WidgetState {...forecast} type="table">{forecast.data?.data_available ? <><div className="table-actions"><span>Forecast and actual values are in MW.</span><CsvButton onDownload={() => downloadForecastCsv(forecast.data.points)} /></div><div className="table-scroll"><table><thead><tr><th>Hour (UTC)</th><th>Forecast (MW)</th><th>Published (UTC)</th><th>Lead (hours)</th><th>Actual (MW)</th></tr></thead><tbody>{forecast.data.points.map((row) => <tr key={row.start_time}><td>{row.start_time.replace("T", " ").replace("Z", "")}</td><td>{fmt(row.forecast_mw)}</td><td>{row.publish_time?.replace("T", " ").replace("Z", "") || "-"}</td><td>{fmt(row.hours_ahead)}</td><td>{fmt(row.actual_mw)}</td></tr>)}</tbody></table></div></> : <div className="empty-state">{forecast.data?.message || "No forecast rows are available."}</div>}</WidgetState></>}
      </div>
    </Card>
  </div>;
}
