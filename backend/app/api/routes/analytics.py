from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.config.settings import settings
from app.data_access.database import cached_snapshot, read_actuals, read_forecasts, row_counts
from app.schemas.responses import (
    AccuracyResponse, ErrorDistributionResponse, EvolutionResponse, ForecastResponse, GroupedMetricsResponse, MetaResponse,
)
from app.services.analytics import (
    aggregate_actuals_hourly, calculate_metrics, cutoff_timestamp, day_bounds, parse_timestamp, percentile, selected_points,
)

router = APIRouter(tags=["wind analytics"])
JAN_START = date(2026, 1, 1)
JAN_END = date(2026, 1, 31)
CUTOFF_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"
_MATCH_CACHE_LOCK = RLock()


def validate_january_day(value: date, field: str) -> None:
    if not JAN_START <= value <= JAN_END:
        raise HTTPException(status_code=422, detail=f"{field} must be between 2026-01-01 and 2026-01-31")


@lru_cache(maxsize=64)
def _cached_decision_points(database_path: str, modified_ns: int, file_size: int, cutoff: str) -> tuple[dict, ...]:
    """Select and join January once per database version and cutoff."""
    del modified_ns, file_size
    actuals, forecasts = cached_snapshot(database_path, JAN_START + timedelta(days=1), JAN_END + timedelta(days=1))
    actuals_by_day: dict[date, list[dict]] = {}
    forecasts_by_day: dict[date, list[dict]] = {}
    for row in actuals:
        if row["settlement_date"]:
            actuals_by_day.setdefault(date.fromisoformat(row["settlement_date"]), []).append(row)
    for row in forecasts:
        target_day = parse_timestamp(row["start_time"]).date()
        forecasts_by_day.setdefault(target_day, []).append(row)
    matched: list[dict] = []
    for day_offset in range((JAN_END - JAN_START).days + 1):
        decision_day = JAN_START + timedelta(days=day_offset)
        delivery_day = decision_day + timedelta(days=1)
        day_data = selected_points(
            decision_day, cutoff, actuals_by_day.get(delivery_day, []), forecasts_by_day.get(delivery_day, []),
        )
        matched.extend(day_data)
    return tuple(matched)


def range_points(database_path: str, start_date: date, end_date: date, cutoff: str) -> tuple[list[dict], int]:
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="from must be on or before to")
    validate_january_day(start_date, "from")
    validate_january_day(end_date, "to")
    stat = Path(database_path).stat()
    with _MATCH_CACHE_LOCK:
        all_points = _cached_decision_points(database_path, stat.st_mtime_ns, stat.st_size, cutoff)
    start_index = (start_date - JAN_START).days * 24
    end_index = ((end_date - JAN_START).days + 1) * 24
    points = list(all_points[start_index:end_index])
    missing = sum(1 for point in points if point["forecast_mw"] is None or point["actual_mw"] is None)
    return points, missing


@router.get("/meta", response_model=MetaResponse, summary="Describe available data and decision assumptions")
def get_meta(request: Request) -> dict[str, Any]:
    dates = [(JAN_START + timedelta(days=offset)).isoformat() for offset in range(31)]
    counts = row_counts(request.app.state.database_path)
    return {
        "available_decision_dates": dates,
        "decision_dates": [{"date": day, "has_data": None, "checked_on_selection": True} for day in dates],
        "default_cutoff_utc": settings.default_cutoff_utc,
        "data_source": "Elexon BMRS Insights API records stored in local SQLite",
        "coverage": {"mode": "stored_snapshot", "decision_dates_in_scope": 31, "rows": counts},
        "assumptions": [
            f"The day-ahead purchase decision cutoff defaults to {settings.default_cutoff_utc} UTC unless configured otherwise; the actual gate-closure time was not verified.",
            "Hourly forecasts are selected using the latest genuine publish_time no later than the cutoff on the decision date.",
            "Actual generation is averaged from the two half-hours for each hour; an incomplete pair is treated as missing.",
            "MAPE excludes actual generation values below 1 MW.",
            "Forecast and actual observations are read from the local SQLite snapshot; request handlers do not call Elexon.",
        ],
    }


@router.get("/forecast", response_model=ForecastResponse, summary="Show the forecast available at decision time")
def get_forecast(
    request: Request,
    decision_date: date = Query(..., description="January 2026 purchase decision date", examples=["2026-01-01"]),
    cutoff: str = Query(settings.default_cutoff_utc, pattern=CUTOFF_PATTERN, description="Decision cutoff in UTC, HH:MM"),
) -> dict[str, Any]:
    validate_january_day(decision_date, "decision_date")
    delivery_date = decision_date + timedelta(days=1)
    start, _ = day_bounds(delivery_date)
    points, _ = range_points(request.app.state.database_path, decision_date, decision_date, cutoff)
    available = [point for point in points if point["forecast_mw"] is not None]
    data_available = bool(available)
    publish_times = sorted({point["publish_time"] for point in available if point["publish_time"]})
    vals = [point["forecast_mw"] for point in available]
    peak = max(available, key=lambda point: point["forecast_mw"]) if available else None
    before_delivery = None
    if publish_times:
        delivery_start = parse_timestamp(start)
        before_delivery = (delivery_start - parse_timestamp(publish_times[-1])).total_seconds() / 3600
    return {
        "data_available": data_available,
        "message": None if data_available else f"No forecast data available for this date: decision date {decision_date.isoformat()}, cutoff {cutoff} UTC, delivery date {delivery_date.isoformat()}.",
        "decision_date": decision_date.isoformat(), "delivery_date": delivery_date.isoformat(), "cutoff": cutoff,
        "cutoff_assumption": "Assumed day-ahead gate closure; actual gate-closure time not verified.",
        "points": points,
        "summary": {
            "average_mw": sum(vals) / len(vals) if vals else None,
            "peak_mw": peak["forecast_mw"] if peak else None,
            "peak_time": peak["start_time"] if peak else None,
            "publish_times": publish_times,
            "earliest_publish_time": publish_times[0] if publish_times else None,
            "latest_publish_time": publish_times[-1] if publish_times else None,
            "hours_before_delivery": before_delivery,
            "n_used": len(available),
            "n_missing_forecast": 24 - len(available),
            "n_missing_actual": sum(point["actual_mw"] is None for point in points),
        },
    }


@router.get("/forecast/evolution", response_model=EvolutionResponse, summary="Compare all revisions for a delivery day")
def get_evolution(
    request: Request,
    decision_date: date = Query(..., description="January 2026 purchase decision date", examples=["2026-01-01"]),
    cutoff: str = Query(settings.default_cutoff_utc, pattern=CUTOFF_PATTERN, description="Decision cutoff in UTC, HH:MM"),
) -> dict[str, Any]:
    validate_january_day(decision_date, "decision_date")
    delivery = decision_date + timedelta(days=1)
    actuals, forecasts = cached_snapshot(request.app.state.database_path, delivery, delivery)
    actual_map = aggregate_actuals_hourly(actuals)
    cutoff_dt = cutoff_timestamp(decision_date, cutoff)
    batches: dict[str, list[dict]] = {}
    for row in forecasts:
        target_time = parse_timestamp(row["start_time"])
        if target_time.date() != delivery or target_time < parse_timestamp(row["publish_time"]):
            continue
        batches.setdefault(row["publish_time"], []).append(row)
    data_available = bool(batches)
    return {
        "data_available": data_available,
        "message": None if data_available else f"No forecast data available for this date: decision date {decision_date.isoformat()}.",
        "decision_date": decision_date.isoformat(), "delivery_date": delivery.isoformat(), "cutoff": cutoff,
        "batches": [{
            "publish_time": publish_time,
            "after_cutoff": parse_timestamp(publish_time) > cutoff_dt,
            "points": [{
                "start_time": row["start_time"], "forecast_mw": row["generation_mw"],
                "publish_time": publish_time,
                "hours_ahead": (parse_timestamp(row["start_time"]) - parse_timestamp(publish_time)).total_seconds() / 3600,
                "actual_mw": actual_map.get(row["start_time"]),
            } for row in sorted(rows, key=lambda item: item["start_time"])],
        } for publish_time, rows in sorted(batches.items())],
    }


def accuracy_payload(start_date: date, end_date: date, cutoff: str, points: list[dict], missing: int) -> dict[str, Any]:
    paired = [(point["forecast_mw"], point["actual_mw"]) for point in points
              if point["forecast_mw"] is not None and point["actual_mw"] is not None]
    metrics = calculate_metrics(paired)
    return {
        "from_date": start_date.isoformat(), "to_date": end_date.isoformat(), "cutoff": cutoff,
        **metrics, "n_missing": missing,
        "series": [{
            "start_time": point["start_time"], "forecast_mw": point["forecast_mw"],
            "actual_mw": point["actual_mw"],
            "error_mw": point["forecast_mw"] - point["actual_mw"]
            if point["forecast_mw"] is not None and point["actual_mw"] is not None else None,
        } for point in points],
    }


@router.get("/accuracy", response_model=AccuracyResponse, summary="Measure decision-time forecast errors")
def get_accuracy(
    request: Request,
    from_date: date = Query(..., alias="from", description="First decision date in January 2026"),
    to_date: date = Query(..., alias="to", description="Last decision date in January 2026"),
    cutoff: str = Query(settings.default_cutoff_utc, pattern=CUTOFF_PATTERN, description="Decision cutoff in UTC, HH:MM"),
) -> dict[str, Any]:
    points, missing = range_points(request.app.state.database_path, from_date, to_date, cutoff)
    return accuracy_payload(from_date, to_date, cutoff, points, missing)


@router.get("/accuracy/error-distribution", response_model=ErrorDistributionResponse, summary="Summarize the distribution of decision-time errors")
def get_error_distribution(
    request: Request,
    from_date: date = Query(..., alias="from", description="First decision date in January 2026"),
    to_date: date = Query(..., alias="to", description="Last decision date in January 2026"),
    cutoff: str = Query(settings.default_cutoff_utc, pattern=CUTOFF_PATTERN, description="Decision cutoff in UTC, HH:MM"),
) -> dict[str, Any]:
    points, _ = range_points(request.app.state.database_path, from_date, to_date, cutoff)
    errors = [p["forecast_mw"] - p["actual_mw"] for p in points if p["forecast_mw"] is not None and p["actual_mw"] is not None]
    if not errors:
        return {"data": [], "n_points": 0, "p5_mw": None, "p50_mw": None, "p95_mw": None}
    low, high = min(errors), max(errors)
    width = max((high - low) / 10, 1.0)
    bins = [{"from_mw": low + i * width, "to_mw": low + (i + 1) * width, "count": 0} for i in range(10)]
    for error in errors:
        index = min(int((error - low) / width), 9)
        bins[index]["count"] += 1
    return {"data": bins, "n_points": len(errors), "p5_mw": percentile(errors, 5),
            "p50_mw": percentile(errors, 50), "p95_mw": percentile(errors, 95),
            "p95_absolute_error_mw": percentile([abs(error) for error in errors], 95)}


@lru_cache(maxsize=64)
def _cached_horizon_payload(
    database_path: str, modified_ns: int, file_size: int, from_date: date, to_date: date,
) -> dict[str, Any]:
    del modified_ns, file_size
    limits = [
        (0, 6, "0-6h"), (6, 12, "6-12h"), (12, 24, "12-24h"),
        (24, 48, "24-48h"), (48, 72, "48-72h"), (72, float("inf"), "72h+"),
    ]
    grouped: dict[str, list[tuple[float, float]]] = {label: [] for _, _, label in limits}
    actuals, forecasts = cached_snapshot(database_path, from_date + timedelta(days=1), to_date + timedelta(days=1))
    actual_map = aggregate_actuals_hourly(actuals)
    for row in forecasts:
        if parse_timestamp(row["start_time"]) < parse_timestamp(row["publish_time"]):
            continue
        actual = actual_map.get(row["start_time"])
        if actual is None:
            continue
        horizon = (parse_timestamp(row["start_time"]) - parse_timestamp(row["publish_time"])).total_seconds() / 3600
        for lower, upper, label in limits:
            if lower <= horizon < upper:
                grouped[label].append((row["generation_mw"], actual)); break
    return {"data": [{"horizon": label, **calculate_metrics(pairs)} for _, _, label in limits
                      for pairs in [grouped[label]]]}


@router.get("/accuracy/by-horizon", response_model=GroupedMetricsResponse, summary="Measure error by forecast lead time")
def get_by_horizon(
    request: Request,
    from_date: date = Query(..., alias="from", description="First decision date in January 2026"),
    to_date: date = Query(..., alias="to", description="Last decision date in January 2026"),
) -> dict[str, Any]:
    if from_date > to_date:
        raise HTTPException(status_code=422, detail="from must be on or before to")
    validate_january_day(from_date, "from"); validate_january_day(to_date, "to")
    stat = Path(request.app.state.database_path).stat()
    with _MATCH_CACHE_LOCK:
        return _cached_horizon_payload(request.app.state.database_path, stat.st_mtime_ns, stat.st_size, from_date, to_date)


@router.get("/accuracy/by-hour-of-day", response_model=GroupedMetricsResponse, summary="Compare decision-time errors by UTC hour")
def get_by_hour(
    request: Request,
    from_date: date = Query(..., alias="from", description="First decision date in January 2026"),
    to_date: date = Query(..., alias="to", description="Last decision date in January 2026"),
    cutoff: str = Query(settings.default_cutoff_utc, pattern=CUTOFF_PATTERN, description="Decision cutoff in UTC, HH:MM"),
) -> dict[str, Any]:
    points, _ = range_points(request.app.state.database_path, from_date, to_date, cutoff)
    grouped: dict[int, list[tuple[float, float]]] = {hour: [] for hour in range(24)}
    for point in points:
        if point["forecast_mw"] is not None and point["actual_mw"] is not None:
            hour = parse_timestamp(point["start_time"]).hour
            grouped[hour].append((point["forecast_mw"], point["actual_mw"]))
    return {"data": [{"hour_utc": hour, **calculate_metrics(grouped[hour])} for hour in range(24)]}
