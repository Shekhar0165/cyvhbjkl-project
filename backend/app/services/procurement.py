"""Pure calibration and purchase-plan calculations for hourly wind data."""

from datetime import date, timedelta
from typing import Any

from app.services.analytics import day_slots, parse_timestamp, percentile, selected_points

JAN_START = date(2026, 1, 1)
JAN_END = date(2026, 1, 31)


def expand_demand(demand_mw: float | list[float]) -> list[float]:
    if isinstance(demand_mw, list):
        if len(demand_mw) != 24:
            raise ValueError("demand_mw must contain exactly 24 hourly values")
        demand = [float(value) for value in demand_mw]
    else:
        demand = [float(demand_mw)] * 24
    if any(value < 0 for value in demand):
        raise ValueError("demand_mw values must be greater than or equal to zero")
    return demand


def _paired_errors(decisions: list[date], cutoff: str, actuals: list[dict], forecasts: list[dict]) -> tuple[list[float], int]:
    errors: list[float] = []
    n_days = 0
    for decision in decisions:
        delivery = decision + timedelta(days=1)
        delivery_text = delivery.isoformat()
        # Avoid rescanning every January revision for every calibration day.
        day_actuals = [row for row in actuals if row["start_time"].startswith(delivery_text)]
        day_forecasts = [row for row in forecasts if row["start_time"].startswith(delivery_text)]
        points = selected_points(decision, cutoff, day_actuals, day_forecasts)
        day_errors = [p["forecast_mw"] - p["actual_mw"] for p in points
                      if p["forecast_mw"] is not None and p["actual_mw"] is not None]
        if day_errors and all(point["actual_mw"] is not None for point in points):
            n_days += 1
            errors.extend(day_errors)
    return errors, n_days


def calibrate(
    decision_date: date, cutoff: str, confidence: float,
    actuals: list[dict], forecasts: list[dict], use_full_month_stats: bool = False,
) -> dict[str, Any]:
    if use_full_month_stats:
        dates = [JAN_START + timedelta(days=i) for i in range(31)]
        window = "All January 2026 decision dates; in-sample demonstration only, unavailable at decision time."
    else:
        last_allowed = decision_date - timedelta(days=2)
        dates = [JAN_START + timedelta(days=i) for i in range(max(0, (last_allowed - JAN_START).days + 1))]
        window = (f"Decision dates 2026-01-01 through {last_allowed.isoformat()} (<= D-2); "
                  "their delivery actuals were complete by decision date D.")
    errors, n_days = _paired_errors(dates, cutoff, actuals, forecasts)
    enough = n_days >= 3 and bool(errors)
    return {
        "status": ("insufficient_history" if not enough else "in_sample" if use_full_month_stats else "ok"),
        "n_days": n_days, "n_points": len(errors),
        "bias_mw": sum(errors) / len(errors) if enough else None,
        "quantile_mw": percentile(errors, confidence * 100) if enough else None,
        "confidence": confidence, "window": window,
        "errors": errors if enough else [],
    }


def build_plan(
    decision_date: date, cutoff: str, confidence: float, demand_mw: float | list[float],
    actuals: list[dict], forecasts: list[dict], use_full_month_stats: bool = False,
    calibration_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    demand = expand_demand(demand_mw)
    delivery_date = decision_date + timedelta(days=1)
    delivery_text = delivery_date.isoformat()
    day_actuals = [row for row in actuals if row["start_time"].startswith(delivery_text)]
    day_forecasts = [row for row in forecasts if row["start_time"].startswith(delivery_text)]
    points = selected_points(decision_date, cutoff, day_actuals, day_forecasts)
    calibration = dict(calibration_result) if calibration_result is not None else calibrate(
        decision_date, cutoff, confidence, actuals, forecasts, use_full_month_stats,
    )
    errors = calibration.pop("errors")
    available = [p for p in points if p["forecast_mw"] is not None]
    if len(available) != 24:
        return {
            "data_available": False,
            "message": f"Stored forecast data is incomplete for delivery date {delivery_date.isoformat()}: {len(available)} of 24 hours are available.",
            "delivery_date": delivery_date.isoformat(), "forecast_batch": {"publish_time": None, "lead_hours": None},
            "calibration": calibration, "hours": [], "summary": {}, "hindsight": None,
            "warnings": ["Forecast data is incomplete in the local SQLite snapshot."],
        }

    if calibration["status"] == "insufficient_history":
        bias, quantile = 0.0, 0.0  # All strategies intentionally fall back to naive.
    else:
        bias, quantile = float(calibration["bias_mw"]), float(calibration["quantile_mw"])
    hourly: list[dict[str, Any]] = []
    for i, point in enumerate(points):
        forecast = float(point["forecast_mw"])
        actual = point["actual_mw"]
        usable_naive = forecast
        usable_bias = forecast - bias
        usable_risk = max(0.0, forecast - quantile)
        needed = lambda usable: max(0.0, demand[i] - usable)
        actual_needed = max(0.0, demand[i] - actual) if actual is not None else None
        hourly.append({
            "hour_start": point["start_time"], "demand_mw": demand[i], "forecast_mw": forecast,
            "usable_wind_naive": usable_naive, "usable_wind_bias_adjusted": usable_bias,
            "usable_wind_risk_adjusted": usable_risk,
            "buy_naive_mw": needed(usable_naive), "buy_bias_adjusted_mw": needed(usable_bias),
            "buy_recommended_mw": needed(usable_risk), "actual_wind_mw": actual,
            "hindsight_needed_mw": actual_needed,
        })

    strategies = {"naive": "buy_naive_mw", "bias_adjusted": "buy_bias_adjusted_mw", "recommended": "buy_recommended_mw"}
    hindsight: dict[str, dict[str, float]] | None = None
    if all(row["hindsight_needed_mw"] is not None for row in hourly):
        hindsight = {}
        for strategy, field in strategies.items():
            short = sum(max(0.0, row["hindsight_needed_mw"] - row[field]) for row in hourly)
            surplus = sum(max(0.0, row[field] - row["hindsight_needed_mw"]) for row in hourly)
            hindsight[strategy] = {"shortfall_mwh": short, "surplus_mwh": surplus}

    recommended = [row["buy_recommended_mw"] for row in hourly]
    naive = [row["buy_naive_mw"] for row in hourly]
    peak_index = max(range(24), key=lambda i: recommended[i])
    batches = sorted({row["publish_time"] for row in points if row["publish_time"]})
    latest_batch = batches[-1] if batches else None
    lead_hours = (parse_timestamp(points[0]["start_time"]) - parse_timestamp(latest_batch)).total_seconds() / 3600 if latest_batch else None
    warnings = []
    if calibration["status"] == "insufficient_history":
        warnings.append("Fewer than three eligible prior delivery days; the plan falls back to naive forecast-only purchases.")
    if use_full_month_stats:
        warnings.append("In-sample full-month statistics include information unavailable at decision time.")
    return {
        "data_available": True, "message": None, "delivery_date": delivery_date.isoformat(),
        "forecast_batch": {"publish_time": latest_batch if len(batches) <= 1 else batches, "lead_hours": lead_hours},
        "calibration": {key: value for key, value in calibration.items() if key != "errors"},
        "hours": hourly,
        "summary": {
            "total_mwh_naive": sum(naive), "total_mwh_recommended": sum(recommended),
            "average_mw": sum(recommended) / 24, "peak_mw": recommended[peak_index],
            "peak_hour": hourly[peak_index]["hour_start"],
            "extra_buffer_mwh": sum(recommended) - sum(naive),
            "extra_buffer_percent": (sum(recommended) - sum(naive)) / sum(naive) * 100 if sum(naive) else None,
        }, "hindsight": hindsight, "warnings": warnings,
    }


def backtest(
    start: date, end: date, cutoff: str, confidence: float, demand_mw: float,
    actuals: list[dict], forecasts: list[dict],
) -> dict[str, Any]:
    strategies = {"naive": "buy_naive_mw", "bias_adjusted": "buy_bias_adjusted_mw", "recommended": "buy_recommended_mw"}
    values = {name: {"shortfall": 0.0, "surplus": 0.0} for name in strategies}
    cover = 0
    evaluated_days = 0
    evaluated_hours = 0
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        calibration = calibrate(day, cutoff, confidence, actuals, forecasts)
        if calibration["status"] != "ok":
            continue
        plan = build_plan(day, cutoff, confidence, demand_mw, actuals, forecasts)
        if not plan["data_available"] or plan["hindsight"] is None:
            continue
        evaluated_days += 1
        for row in plan["hours"]:
            need = row["hindsight_needed_mw"]
            evaluated_hours += 1
            cover += row["buy_recommended_mw"] >= need
            for strategy, field in strategies.items():
                values[strategy]["shortfall"] += max(0.0, need - row[field])
                values[strategy]["surplus"] += max(0.0, row[field] - need)
    return {
        "from_date": start.isoformat(), "to_date": end.isoformat(), "cutoff": cutoff,
        "confidence": confidence, "demand_mw": demand_mw, "demand_note": "Results depend on this placeholder/user demand; with flat demand, coverage depends only on wind error.",
        "n_days_evaluated": evaluated_days, "n_hours_evaluated": evaluated_hours,
        "coverage": cover / evaluated_hours if evaluated_hours else None,
        "target_coverage": confidence,
        "strategies": {name: {
            "total_shortfall_mwh": value["shortfall"], "average_shortfall_mwh_per_day": value["shortfall"] / evaluated_days if evaluated_days else None,
            "total_surplus_mwh": value["surplus"], "average_surplus_mwh_per_day": value["surplus"] / evaluated_days if evaluated_days else None,
        } for name, value in values.items()},
    }
