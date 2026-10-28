import { useMemo, useState } from "react";
import { Area, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import CsvButton from "../ui/CsvButton";
import Skeleton from "../ui/Skeleton";
import ChartContainer, { chartColors } from "../ui/ChartContainer";

const DEFAULT_DEMAND = Array(24).fill("30000");
const fmt = (value, digits = 0) => value == null ? "-" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(value);
const localTime = (value) => value ? `${value.slice(11, 16)} UTC` : "-";
const dateLabel = (value) => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : "-";
const chartMotionEnabled = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

function Section({ title, description, children, className = "" }) {
  return <section className={`panel ${className}`}><div className="section-heading"><div><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}

function MetricCard({ label, value, unit = "MW", hint }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}{value !== "-" && unit ? <small> {unit}</small> : null}</strong>{hint && <p>{hint}</p>}</article>;
}

function LoadingPanel() {
  return <Skeleton kind="chart" />;
}

function ChartEmpty({ text = "No matching data is available for this selection." }) {
  return <div className="empty-chart">{text}</div>;
}

function NoForecastDataNotice({ message }) {
  return <div className="error-box" role="status"><div><strong>No forecast data available for this date</strong><p>{message}</p></div></div>;
}

function ErrorBlock({ error, retry }) {
  return <div className="error-box" role="alert"><div><strong>We couldn't load this view.</strong><p>{error}</p></div><button className="button secondary" onClick={retry}>Try again</button></div>;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.filter((row) => row.value != null).map((row) => <div key={row.dataKey}><i style={{ background: row.color }} />{row.name}: {fmt(row.value, 1)} MW</div>)}</div>;
}

function downloadCsv(points) {
  const columns = ["start_time", "forecast_mw", "publish_time", "hours_ahead", "actual_mw"];
  const lines = [columns.join(","), ...points.map((row) => columns.map((key) => row[key] ?? "").join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "winddesk-forecast.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function ForecastView({ result, evolution, busy, error, retry }) {
  const chartData = useMemo(() => (result?.points || []).map((point) => ({
    ...point, label: localTime(point.start_time), forecast: point.forecast_mw, actual: point.actual_mw,
  })), [result]);
  const revisions = useMemo(() => {
    const rows = new Map((result?.points || []).map((point) => [point.start_time, { start_time: point.start_time, label: localTime(point.start_time) }]));
    (evolution?.batches || []).forEach((batch, index) => batch.points.forEach((point) => {
      const target = rows.get(point.start_time);
      if (target) target[`revision_${index}`] = point.forecast_mw;
    }));
    return [...rows.values()];
  }, [result, evolution]);
  const batchNames = evolution?.batches || [];
  const summary = result?.summary;

  if (busy) return <LoadingPanel />;
  if (result?.data_available === false) return <NoForecastDataNotice message={result.message || "No forecast data available for this date."} />;
  if (error?.includes("No forecast data available for this date")) return <NoForecastDataNotice message={error} />;
  if (error) return <ErrorBlock error={error} retry={retry} />;
  if (!result) return <ChartEmpty />;

  return <>
    <Section title="Decision snapshot" description="These are the latest forecast values that were actually available by your selected cutoff.">
      <div className="metric-grid five">
        <MetricCard label="Average forecast" value={fmt(summary.average_mw)} />
        <MetricCard label="Peak forecast" value={fmt(summary.peak_mw)} />
        <MetricCard label="Peak delivery time" value={localTime(summary.peak_time)} unit="" />
        <MetricCard label="Latest batch used" value={localTime(summary.latest_publish_time)} unit="" />
        <MetricCard label="Batch lead at delivery" value={fmt(summary.hours_before_delivery, 1)} unit="hours" />
      </div>
      <div className="inline-note">{summary.n_used} of 24 hourly intervals have a usable forecast | {summary.n_missing_actual} actual hours missing.</div>
    </Section>
    <Section title="Forecast and actual generation" description="Compare the selected hourly wind forecast with hourly actuals averaged from both half-hours; gaps show missing values.">
      {chartData.some((row) => row.forecast != null || row.actual != null) ? <ChartContainer name="Selected forecast and actual" height={320}><LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 4, left: 0 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="label" interval={2} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Hour (UTC)", position: "insideBottom", offset: -8 }} /><YAxis width={65} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Generation (MW)", angle: -90, position: "insideLeft" }} /><Tooltip content={<ChartTooltip />} /><Legend /><Line type="monotone" dataKey="forecast" name="Forecast" stroke={chartColors.forecast} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /><Line type="monotone" dataKey="actual" name="Actual" stroke={chartColors.actual} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /></LineChart></ChartContainer> : <ChartEmpty />}
    </Section>
    <Section title="Forecast revisions" description="Each line is a published forecast batch. Dashed lines were published after the cutoff and were NOT available to the trader.">
      {batchNames.length ? <ChartContainer name="Forecast evolution" height={320}><LineChart data={revisions} margin={{ top: 10, right: 20, bottom: 4, left: 0 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="label" interval={2} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Hour (UTC)", position: "insideBottom", offset: -8 }} /><YAxis width={65} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Generation (MW)", angle: -90, position: "insideLeft" }} /><Tooltip content={<ChartTooltip />} /><Legend />{batchNames.map((batch, index) => <Line key={batch.publish_time} type="monotone" dataKey={`revision_${index}`} name={`${localTime(batch.publish_time)}${batch.after_cutoff ? " | AFTER cutoff" : ""}`} stroke={batch.after_cutoff ? chartColors.axis : chartColors.forecast} strokeWidth={batch.after_cutoff ? 1.5 : 2.5} strokeDasharray={batch.after_cutoff ? "5 5" : undefined} strokeOpacity={batch.after_cutoff ? 0.55 : 1} dot={false} connectNulls={false}  isAnimationActive={chartMotionEnabled()} animationDuration={700} />)}</LineChart></ChartContainer> : <ChartEmpty text="No forecast revisions are stored for this delivery day." />}
    </Section>
    <Section title="Hourly forecast detail" description="Review the hourly forecast, publication time, lead time, and the mean of its two matching half-hour actuals.">
      <div className="table-actions"><span>{result.delivery_date} | {result.cutoff} UTC cutoff</span><CsvButton onDownload={() => downloadCsv(result.points)} /></div>
      <div className="table-scroll"><table><thead><tr><th>Start time (UTC)</th><th>Forecast (MW)</th><th>Published (UTC)</th><th>Hours ahead</th><th>Actual (MW)</th></tr></thead><tbody>{result.points.map((row) => <tr key={row.start_time}><td>{row.start_time.replace("T", " ").replace("Z", "")}</td><td>{fmt(row.forecast_mw, 1)}</td><td>{row.publish_time?.replace("T", " ").replace("Z", "") || "-"}</td><td>{fmt(row.hours_ahead, 1)}</td><td>{fmt(row.actual_mw, 1)}</td></tr>)}</tbody></table></div>
    </Section>
  </>;
}

function AccuracyView({ accuracy, distribution, horizon, byHour, busy, error, retry }) {
  const series = accuracy?.series || [];
  const chartData = series.map((row) => ({ ...row, label: `${dateLabel(row.start_time.slice(0, 10))} ${localTime(row.start_time)}`, forecast: row.forecast_mw, actual: row.actual_mw }));
  const horizonRows = horizon?.data || [];
  const hourRows = byHour?.data || [];
  const p95Buffer = distribution?.p95_absolute_error_mw;
  const shortLeadMae = horizonRows.find((row) => row.horizon === "0-6h")?.mae_mw;
  const longLeadMae = horizonRows.find((row) => row.horizon === "48-72h")?.mae_mw;
  const horizonTakeaway = shortLeadMae == null || longLeadMae == null
    ? "There are not enough matched forecasts in both the shortest and longest lead-time bins to compare them."
    : longLeadMae > shortLeadMae
      ? `The 48-72h forecasts have ${fmt(longLeadMae - shortLeadMae)} MW higher MAE than the 0-6h forecasts in this range.`
      : `The 48-72h forecasts are ${fmt(shortLeadMae - longLeadMae)} MW lower in MAE than the 0-6h forecasts in this range.`;

  if (busy) return <LoadingPanel />;
  if (error) return <ErrorBlock error={error} retry={retry} />;
  if (!accuracy) return <ChartEmpty />;

  return <>
    <Section title="Accuracy summary" description="These scores use only the forecast revision available at the chosen cutoff; positive bias means wind was over-forecast.">
      <div className="metric-grid five"><MetricCard label="MAE" value={fmt(accuracy.mae_mw, 1)} hint="Average absolute error" /><MetricCard label="RMSE" value={fmt(accuracy.rmse_mw, 1)} hint="Penalizes larger misses" /><MetricCard label="Bias" value={fmt(accuracy.bias_mw, 1)} hint="Positive = over-forecast" /><MetricCard label="MAPE" value={accuracy.mape_percent == null ? "-" : fmt(accuracy.mape_percent, 1)} unit="%" hint="Actuals under 1 MW excluded" /><MetricCard label="Points used / missing" value={`${accuracy.n_points} / ${accuracy.n_missing}`} unit="" hint="Hourly delivery periods" /></div>
    </Section>
    <Section title="Forecast against actual" description="Follow forecast and actual generation over the selected decision-date range; a close overlap indicates smaller error.">{accuracy.bias_mw != null && <p className="plain-note">Over this period, forecasts exceeded actual wind by an average of {fmt(accuracy.bias_mw, 1)} MW. Buying against the raw wind forecast alone could therefore leave a systematic purchase shortfall.</p>}
      {chartData.length ? <ChartContainer name="Accuracy forecast and actual overlay" height={320}><LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 4, left: 0 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="label" minTickGap={34} tick={{ fill: chartColors.axis, fontSize: 11 }} label={{ value: "Delivery time (UTC)", position: "insideBottom", offset: -8 }} /><YAxis width={65} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Generation (MW)", angle: -90, position: "insideLeft" }} /><Tooltip content={<ChartTooltip />} /><Legend /><Line type="monotone" dataKey="forecast" name="Forecast" stroke={chartColors.forecast} strokeWidth={2} dot={false}  isAnimationActive={chartMotionEnabled()} animationDuration={700} /><Line type="monotone" dataKey="actual" name="Actual" stroke={chartColors.actual} strokeWidth={1.7} strokeDasharray="5 4" dot={false}  isAnimationActive={chartMotionEnabled()} animationDuration={700} /></LineChart></ChartContainer> : <ChartEmpty />}
    </Section>
    <div className="two-column">
      <Section title="Error distribution" description="Bars count forecast-minus-actual errors. Percentiles show the typical lower, middle, and upper error values.">
        {distribution?.data?.length ? <><ChartContainer name="Accuracy error histogram" height={260}><BarChart data={distribution.data}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="from_mw" tickFormatter={(value) => fmt(value)} tick={{ fontSize: 11 }} label={{ value: "Forecast error (MW)", position: "insideBottom", offset: -8 }} /><YAxis allowDecimals={false} label={{ value: "Hours", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value, _name, item) => [value, `${fmt(item.payload.from_mw)} to ${fmt(item.payload.to_mw)} MW`]} /><Legend /><Bar dataKey="count" name="Intervals" fill={chartColors.forecast} radius={[4, 4, 0, 0]}  isAnimationActive={chartMotionEnabled()} animationDuration={700} /></BarChart></ChartContainer><div className="percentile-row"><span>P5 <b>{fmt(distribution.p5_mw, 1)} MW</b></span><span>Median <b>{fmt(distribution.p50_mw, 1)} MW</b></span><span>P95 <b>{fmt(distribution.p95_mw, 1)} MW</b></span></div></> : <ChartEmpty />}
      </Section>
      <Section title="Error by forecast horizon" description="Each bar groups all revisions by how long before delivery they were published; read higher bars as less accurate.">
        {horizonRows.length ? <><ChartContainer name="Accuracy by forecast horizon" height={260}><BarChart data={horizonRows}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="horizon" tick={{ fontSize: 11 }} label={{ value: "Lead time", position: "insideBottom", offset: -8 }} /><YAxis label={{ value: "MAE (MW)", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value) => [`${fmt(value, 1)} MW`, "MAE"]} /><Legend /><Bar dataKey="mae_mw" name="MAE" fill={chartColors.forecast} radius={[4, 4, 0, 0]}  isAnimationActive={chartMotionEnabled()} animationDuration={700} /></BarChart></ChartContainer><div className="inline-note">{horizonTakeaway}</div></> : <ChartEmpty />}
      </Section>
    </div>
    <Section title="Average error by delivery hour" description="Compare the average absolute miss and signed bias at each UTC delivery hour to find recurring daily patterns.">
      {hourRows.length ? <ChartContainer name="Accuracy by hour of day" height={260}><BarChart data={hourRows}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="hour_utc" tickFormatter={(value) => `${String(value).padStart(2, "0")}:00`} tick={{ fontSize: 11 }} label={{ value: "Hour of day (UTC)", position: "insideBottom", offset: -8 }} /><YAxis label={{ value: "Error (MW)", angle: -90, position: "insideLeft" }} /><Tooltip formatter={(value, name) => [`${fmt(value, 1)} MW`, name === "mae_mw" ? "MAE" : "Bias"]} /><Legend /><Bar dataKey="mae_mw" name="MAE" fill={chartColors.forecast} radius={[3, 3, 0, 0]} isAnimationActive={chartMotionEnabled()} animationDuration={700} /><Bar dataKey="bias_mw" name="Bias" fill={chartColors.warning} radius={[3, 3, 0, 0]} isAnimationActive={chartMotionEnabled()} animationDuration={700} /></BarChart></ChartContainer> : <ChartEmpty />}
    </Section>
    <Section title="How to use this for buying decisions" description="Use the observed miss size as a planning input, then combine it with plant availability and commercial risk limits.">
      <div className="guidance-panel"><div className="guidance-number">{p95Buffer == null ? "-" : `~ ${fmt(p95Buffer)} MW`}</div><p>On this data range, the 95th percentile absolute forecast error is a useful reference for a wind uncertainty buffer. It is a historical estimate, not a guaranteed reserve requirement.</p></div>
    </Section>
  </>;
}

function BuyPlanView({ result, backtest, demand, setDemand, mode, setMode, confidence, setConfidence, fullMonth, setFullMonth, busy, error, retry, calculate, backtestBusy, backtestError }) {
  const [pasted, setPasted] = useState("");
  const [inputError, setInputError] = useState("");
  const chartData = useMemo(() => (result?.hours || []).map((row) => ({
    ...row, label: localTime(row.hour_start), demand: row.demand_mw,
    forecast: row.forecast_mw, usable: row.usable_wind_risk_adjusted,
    purchase: row.buy_recommended_mw, actual: row.actual_wind_mw,
  })), [result]);
  const submit = () => {
    setInputError("");
    let hourly;
    if (mode === "flat") {
      const value = Number(demand[0]);
      if (!Number.isFinite(value) || value < 0) return setInputError("Enter a valid non-negative demand in MW.");
      hourly = value;
    } else if (mode === "table") {
      hourly = demand.map(Number);
    } else {
      hourly = pasted.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    }
    if (Array.isArray(hourly) && (hourly.length !== 24 || hourly.some((v) => !Number.isFinite(v) || v < 0))) {
      return setInputError("Provide exactly 24 non-negative numeric hourly demand values.");
    }
    calculate(hourly);
  };
  const tableRows = Array.from({ length: 24 }, (_, hour) => hour);
  const strategyLabels = { naive: "Naive", bias_adjusted: "Bias-adjusted", recommended: "Risk-adjusted" };
  const summary = result?.summary || {};
  const firstBatch = Array.isArray(result?.forecast_batch?.publish_time) ? result.forecast_batch.publish_time.at(-1) : result?.forecast_batch?.publish_time;
  const sentence = result?.data_available
    ? `Based on the ${localTime(firstBatch)} forecast (${fmt(result.forecast_batch.lead_hours, 1)} h before delivery) and errors from ${result.calibration.n_days} prior days, plan ${fmt(summary.total_mwh_recommended)} MWh; the raw forecast alone would plan ${fmt(summary.total_mwh_naive)} MWh.`
    : "A purchase plan will be calculated when a complete stored hourly forecast is available for this delivery day.";

  return <>
    <Section title="Plan inputs" description="Demand is your own expected consumer load, not Elexon data; set the date and cutoff in the shared control bar above.">
      <div className="plan-input-grid">
        <label><span>Confidence level</span><select value={confidence} onChange={(event) => setConfidence(Number(event.target.value))}>{[0.5, 0.8, 0.9, 0.95].map((value) => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
        <label><span>Demand input mode</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="flat">Flat MW for all 24 hours</option><option value="table">Edit 24-hour table</option><option value="paste">Paste 24 values</option></select></label>
      </div>
      <div className="placeholder-note"><strong>Placeholder demand:</strong> replace with your own forecast before using this plan. Default is 30,000 MW.</div>
      {mode === "flat" && <label className="demand-flat"><span>Demand for each hour (MW)</span><input type="number" min="0" step="any" value={demand[0]} onChange={(event) => setDemand(Array(24).fill(event.target.value))} /></label>}
      {mode === "table" && <div className="demand-grid">{tableRows.map((hour) => <label key={hour}><span>{String(hour).padStart(2, "0")}:00 UTC (MW)</span><input aria-label={`Demand at ${hour}:00 UTC`} type="number" min="0" step="any" value={demand[hour]} onChange={(event) => setDemand(demand.map((value, index) => index === hour ? event.target.value : value))} /></label>)}</div>}
      {mode === "paste" && <label className="paste-demand"><span>Paste 24 comma or newline-separated values (MW)</span><textarea rows="5" value={pasted} onChange={(event) => { const text = event.target.value; setPasted(text); const values = text.trim().split(/[\s,]+/).filter(Boolean).map(Number); if (values.length === 24 && values.every((value) => Number.isFinite(value) && value >= 0)) setDemand(values.map(String)); }} placeholder={DEFAULT_DEMAND.join(", ")} /></label>}
      <label className="checkbox-row"><input type="checkbox" checked={fullMonth} onChange={(event) => setFullMonth(event.target.checked)} />Use full-month error statistics (in-sample, for demonstration only)</label>
      {inputError && <p className="input-error" role="alert">{inputError}</p>}
      <button className="button primary calculate-button" onClick={submit} disabled={busy}>{busy && <span className="spinner" aria-hidden="true" />}{busy ? "Calculating..." : "Calculate plan"}</button>
    </Section>
    {busy ? <LoadingPanel /> : error ? <ErrorBlock error={error} retry={retry} /> : result?.data_available === false ? <div className="empty-state" role="status"><strong>No complete forecast snapshot for this delivery day</strong><p>{result.message}</p><p>The current SQLite file contains no stored forecasts. The plan will not substitute fabricated wind values.</p></div> : result?.data_available && <>
      <Section title={`Recommended purchase for ${result.delivery_date}`} description="The risk-adjusted total is the demand left after conservatively usable wind; hourly MW sums to MWh over this 24-hour delivery day." className="recommendation-panel">
        <div className="recommendation-grid"><div className="recommendation-main"><span>Recommended purchase</span><strong>{fmt(summary.total_mwh_recommended)} <small>MWh</small></strong><p>Peak {fmt(summary.peak_mw)} MW at {localTime(summary.peak_hour)} | average {fmt(summary.average_mw)} MW</p></div><div className="recommendation-side"><div><span>Naive forecast-only total</span><strong>{fmt(summary.total_mwh_naive)} MWh</strong></div><div><span>Extra risk buffer</span><strong>{fmt(summary.extra_buffer_mwh)} MWh ({fmt(summary.extra_buffer_percent, 1)}%)</strong></div></div></div>
        <p className="buy-sentence">{sentence}</p>
      </Section>
      <Section title="Hourly purchase profile" description="Demand is compared with forecast and risk-adjusted usable wind; the filled area is the recommended amount to procure.">
      <ChartContainer name="Buy plan hourly profile" height={320}><LineChart data={chartData} margin={{ top: 10, right: 25, bottom: 14, left: 14 }}><CartesianGrid stroke={chartColors.grid} vertical={false} /><XAxis dataKey="label" interval={2} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Hour (UTC)", position: "insideBottom", offset: -8 }} /><YAxis width={75} tick={{ fill: chartColors.axis, fontSize: 12 }} label={{ value: "Power (MW)", angle: -90, position: "insideLeft" }} /><Tooltip content={<ChartTooltip />} /><Legend /><Area type="monotone" dataKey="purchase" name="Recommended purchase gap" stroke={chartColors.error} fill={chartColors.errorFill} fillOpacity={0.65} isAnimationActive={chartMotionEnabled()} animationDuration={760} /><Line type="monotone" dataKey="demand" name="Demand input" stroke={chartColors.actual} strokeWidth={2} dot={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /><Line type="monotone" dataKey="forecast" name="Wind forecast" stroke={chartColors.forecast} strokeWidth={2} dot={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /><Line type="monotone" dataKey="usable" name="Risk-adjusted usable wind" stroke={chartColors.success} strokeWidth={2} dot={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /><Line type="monotone" dataKey="actual" name="Actual wind (hindsight)" stroke={chartColors.actual} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={chartMotionEnabled()} animationDuration={760} /></LineChart></ChartContainer>
      </Section>
      <Section title="Hourly purchase detail" description="Check each hour's demand, selected wind, risk-adjusted usable amount, and purchase needed; download the same values as CSV.">
        <div className="table-actions"><span>MW per hour | totals in MWh</span><CsvButton label="Download plan CSV" onDownload={() => downloadPlanCsv(result.hours)} /></div>
        <div className="table-scroll"><table><thead><tr><th>Hour (UTC)</th><th>Demand (MW)</th><th>Wind forecast (MW)</th><th>Usable wind (MW)</th><th>Recommended buy (MW)</th><th>Naive buy (MW)</th><th>Actual needed (MW)</th></tr></thead><tbody>{result.hours.map((row) => <tr key={row.hour_start}><td>{localTime(row.hour_start)}</td><td>{fmt(row.demand_mw)}</td><td>{fmt(row.forecast_mw)}</td><td>{fmt(row.usable_wind_risk_adjusted)}</td><td>{fmt(row.buy_recommended_mw)}</td><td>{fmt(row.buy_naive_mw)}</td><td>{fmt(row.hindsight_needed_mw)}</td></tr>)}</tbody></table></div>
      </Section>
      <Section title="Why this number" description="Review the signed historical forecast error used to adjust wind and the amount of evidence behind it.">
        <div className="metric-grid five"><MetricCard label="Mean bias" value={fmt(result.calibration.bias_mw, 1)} hint="Positive means forecast wind was too high" /><MetricCard label={`${confidence * 100}% error quantile`} value={fmt(result.calibration.quantile_mw, 1)} hint="Signed forecast minus actual" /><MetricCard label="Prior days" value={result.calibration.n_days} unit="days" /><MetricCard label="Hourly points" value={result.calibration.n_points} unit="points" /><article className="metric-card"><span>Calibration status</span><strong>{result.calibration.status}</strong></article></div>
        <p className="plain-note">Errors are pooled across all hours because the sample for each hour of day is small. This is one month of history, so the calibration sample is limited.</p>
        {result.warnings.map((warning) => <p className="warning-line" key={warning}>{warning}</p>)}
      </Section>
      {result.hindsight && <Section title="What would have happened" description="Hindsight compares each strategy's purchase with demand left after actual wind; shortfall means under-purchase and surplus means over-purchase."><div className="metric-grid three">{["naive", "recommended"].map((key) => <article className="metric-card" key={key}><span>{key === "naive" ? "Naive" : "Recommended"}</span><strong>{fmt(result.hindsight[key].shortfall_mwh)} <small>MWh short</small></strong><p>{fmt(result.hindsight[key].surplus_mwh)} MWh surplus</p></article>)}</div></Section>}
    </>}
    <Section title="Backtest over January" description="Walk-forward dates are calibrated only on history available by each decision cutoff; compare achieved hourly coverage with the selected confidence target.">
      <p className="plain-note">Backtest results depend on the placeholder demand assumption of 30,000 MW; when demand is flat, coverage depends only on wind forecast errors.</p>
      {!backtest || backtest.n_days_evaluated === 0 ? <ChartEmpty text="No eligible forecast history is available for the January backtest." /> : <><div className="metric-grid three"><MetricCard label="Recommended coverage" value={backtest.coverage == null ? "-" : fmt(backtest.coverage * 100, 1)} unit="%" hint={`Target ${backtest.target_coverage * 100}%`} /><MetricCard label="Days evaluated" value={backtest.n_days_evaluated} unit="days" /><MetricCard label="Hourly points" value={backtest.n_hours_evaluated} unit="hours" /></div><div className="table-scroll"><table><thead><tr><th>Strategy</th><th>Shortfall total (MWh)</th><th>Shortfall avg/day (MWh)</th><th>Surplus total (MWh)</th><th>Surplus avg/day (MWh)</th></tr></thead><tbody>{Object.entries(backtest.strategies || {}).map(([key, value]) => <tr key={key}><td>{strategyLabels[key] || key}</td><td>{fmt(value.total_shortfall_mwh, 1)}</td><td>{fmt(value.average_shortfall_mwh_per_day, 1)}</td><td>{fmt(value.total_surplus_mwh, 1)}</td><td>{fmt(value.average_surplus_mwh_per_day, 1)}</td></tr>)}</tbody></table></div><p className="plain-note">{backtest.n_days_evaluated ? `The walk-forward test evaluated ${backtest.n_days_evaluated} days after the three-day minimum history requirement.` : "No days could be evaluated from the available stored forecast snapshot."}</p></>}
    </Section>
  </>;
}

function downloadPlanCsv(rows) {
  const keys = ["hour_start", "demand_mw", "forecast_mw", "usable_wind_risk_adjusted", "buy_recommended_mw", "buy_naive_mw", "hindsight_needed_mw"];
  const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => row[key] ?? "").join(","))].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "winddesk-buy-plan.csv"; link.click(); URL.revokeObjectURL(link.href);
}


export default function LegacyPages({ page, ...props }) {
  if (page === "forecast") return <ForecastView {...props} />;
  if (page === "accuracy") return <AccuracyView {...props} />;
  return <BuyPlanView {...props} />;
}
