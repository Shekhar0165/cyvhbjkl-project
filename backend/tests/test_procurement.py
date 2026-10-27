from datetime import date, timedelta

import pytest

from app.services.analytics import day_slots
from app.services.procurement import backtest, build_plan, calibrate, expand_demand


def make_day(decision: date, forecast: float, actual: float) -> tuple[list[dict], list[dict]]:
    delivery = decision + timedelta(days=1)
    actuals = []
    forecasts = []
    for slot in day_slots(delivery):
        actuals.extend([
            {"start_time": slot, "generation_mw": actual - 1},
            {"start_time": slot[:13] + ":30:00Z", "generation_mw": actual + 1},
        ])
        forecasts.append({
            "start_time": slot, "publish_time": f"{decision.isoformat()}T09:30:00Z",
            "generation_mw": forecast,
        })
    return actuals, forecasts


def join(*days):
    return [item for pair in days for item in pair[0]], [item for pair in days for item in pair[1]]


def test_calibration_uses_only_decision_dates_through_d_minus_two():
    prior = [make_day(date(2026, 1, day), 12, 10) for day in (1, 2, 3)]
    future_bad = make_day(date(2026, 1, 4), 10000, 1)
    actuals, forecasts = join(*prior, future_bad)
    result = calibrate(date(2026, 1, 5), "10:00", 0.9, actuals, forecasts)
    assert result["status"] == "ok"
    assert result["n_days"] == 3
    assert result["bias_mw"] == pytest.approx(2)
    assert result["quantile_mw"] == pytest.approx(2)
    assert "through 2026-01-03" in result["window"]


def test_insufficient_history_with_fewer_than_three_prior_days():
    actuals, forecasts = join(make_day(date(2026, 1, 1), 12, 10), make_day(date(2026, 1, 2), 12, 10))
    result = calibrate(date(2026, 1, 4), "10:00", 0.9, actuals, forecasts)
    assert result["status"] == "insufficient_history"
    assert result["n_days"] == 2
    assert result["bias_mw"] is None


def test_plan_formulas_quantile_clipping_and_hindsight():
    histories = [make_day(date(2026, 1, day), 12, 10) for day in (1, 2, 3)]
    current = make_day(date(2026, 1, 5), 10, 8)
    actuals, forecasts = join(*histories, current)
    plan = build_plan(date(2026, 1, 5), "10:00", 0.5, 15, actuals, forecasts)
    assert plan["calibration"]["bias_mw"] == pytest.approx(2)
    assert plan["calibration"]["quantile_mw"] == pytest.approx(2)
    row = plan["hours"][0]
    assert row["buy_naive_mw"] == pytest.approx(5)
    assert row["buy_bias_adjusted_mw"] == pytest.approx(7)
    assert row["buy_recommended_mw"] == pytest.approx(7)
    assert plan["hindsight"]["naive"]["shortfall_mwh"] == pytest.approx(48)
    assert plan["hindsight"]["recommended"]["shortfall_mwh"] == pytest.approx(0)
    high_errors = [make_day(date(2026, 1, day), 20, 10) for day in (1, 2, 3)]
    low_forecast = make_day(date(2026, 1, 5), 3, 5)
    clipping_actuals, clipping_forecasts = join(*high_errors, low_forecast)
    clipped = build_plan(date(2026, 1, 5), "10:00", 0.95, 15, clipping_actuals, clipping_forecasts)
    assert clipped["hours"][0]["usable_wind_risk_adjusted"] == 0
    assert clipped["hours"][0]["buy_recommended_mw"] == 15

    surplus_delivery = make_day(date(2026, 1, 5), 10, 10)
    surplus_actuals, surplus_forecasts = join(*histories, surplus_delivery)
    surplus_plan = build_plan(date(2026, 1, 5), "10:00", 0.5, 15, surplus_actuals, surplus_forecasts)
    assert surplus_plan["hindsight"]["recommended"]["surplus_mwh"] == pytest.approx(48)


def test_full_month_is_explicitly_in_sample_and_demand_validates():
    days = [make_day(date(2026, 1, day), 12, 10) for day in (1, 2, 3)]
    actuals, forecasts = join(*days)
    result = calibrate(date(2026, 1, 4), "10:00", 0.9, actuals, forecasts, True)
    assert result["status"] == "in_sample"
    assert "in-sample" in result["window"]
    with pytest.raises(ValueError, match="exactly 24"):
        expand_demand([1] * 23)
    with pytest.raises(ValueError, match="greater than or equal to zero"):
        expand_demand(-1)
