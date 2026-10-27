from datetime import date, datetime, time, timedelta, timezone
from math import sqrt
from typing import Any

UTC = timezone.utc


def iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def day_bounds(day: date) -> tuple[str, str]:
    start = datetime.combine(day, time.min, tzinfo=UTC)
    return iso_utc(start), iso_utc(start + timedelta(days=1))


def day_slots(day: date) -> list[str]:
    """Return the 24 hourly UTC start times for a delivery day."""
    midnight = datetime.combine(day, time.min, tzinfo=UTC)
    return [iso_utc(midnight + timedelta(hours=index)) for index in range(24)]


def aggregate_actuals_hourly(actuals: list[dict[str, Any]]) -> dict[str, float]:
    """Average each complete :00/:30 actual pair; omit incomplete hours."""
    grouped: dict[str, dict[int, float]] = {}
    for row in actuals:
        instant = parse_timestamp(row["start_time"])
        if instant.minute not in (0, 30):
            continue
        hour = iso_utc(instant.replace(minute=0, second=0, microsecond=0))
        grouped.setdefault(hour, {})[instant.minute] = float(row["generation_mw"])
    return {
        hour: (readings[0] + readings[30]) / 2
        for hour, readings in grouped.items()
        if 0 in readings and 30 in readings
    }


def cutoff_timestamp(decision_date: date, cutoff: str) -> datetime:
    hour, minute = (int(value) for value in cutoff.split(":"))
    return datetime.combine(decision_date, time(hour, minute), tzinfo=UTC)


def select_forecasts(
    start_times: list[str], forecasts: list[dict[str, Any]], cutoff: datetime
) -> dict[str, dict[str, Any]]:
    """Pick the newest genuine forecast at or before cutoff for each target hour."""
    selected: dict[str, dict[str, Any]] = {}
    for row in forecasts:
        published = parse_timestamp(row["publish_time"])
        target_time = parse_timestamp(row["start_time"])
        if target_time < published:
            continue  # Historical hindsight rows are not forecasts.
        target = iso_utc(target_time)
        if published <= cutoff and (target not in selected or published > parse_timestamp(selected[target]["publish_time"])):
            selected[target] = row
    return {start_time: selected[start_time] for start_time in start_times if start_time in selected}


def calculate_metrics(pairs: list[tuple[float, float]]) -> dict[str, float | int | None]:
    """Error is forecast minus actual; MAPE skips actuals below 1 MW."""
    if not pairs:
        return {"mae_mw": None, "rmse_mw": None, "bias_mw": None, "mape_percent": None, "n_points": 0}
    errors = [forecast - actual for forecast, actual in pairs]
    mape_values = [abs(error) / abs(actual) * 100 for error, (_, actual) in zip(errors, pairs) if abs(actual) >= 1.0]
    return {
        "mae_mw": sum(abs(error) for error in errors) / len(errors),
        "rmse_mw": sqrt(sum(error * error for error in errors) / len(errors)),
        "bias_mw": sum(errors) / len(errors),
        "mape_percent": sum(mape_values) / len(mape_values) if mape_values else None,
        "n_points": len(pairs),
    }


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def selected_points(
    decision_date: date, cutoff: str, actuals: list[dict], forecasts: list[dict]
) -> list[dict[str, Any]]:
    delivery_date = decision_date + timedelta(days=1)
    slots = day_slots(delivery_date)
    decision_cutoff = cutoff_timestamp(decision_date, cutoff)
    chosen = select_forecasts(slots, forecasts, decision_cutoff)
    actual_map = aggregate_actuals_hourly(actuals)
    result = []
    for start_time in slots:
        forecast = chosen.get(start_time)
        publish_time = forecast["publish_time"] if forecast else None
        horizon = (parse_timestamp(start_time) - parse_timestamp(publish_time)).total_seconds() / 3600 if publish_time else None
        result.append({
            "start_time": start_time,
            "forecast_mw": forecast["generation_mw"] if forecast else None,
            "publish_time": publish_time,
            "hours_ahead": horizon,
            "actual_mw": actual_map.get(start_time),
        })
    return result
