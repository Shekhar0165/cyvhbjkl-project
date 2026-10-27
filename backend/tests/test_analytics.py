import math
from datetime import date, datetime, timezone

import pytest

from app.services.analytics import aggregate_actuals_hourly, calculate_metrics, day_slots, select_forecasts


def test_delivery_day_has_24_hourly_slots():
    assert len(day_slots(date(2026, 1, 2))) == 24
    assert day_slots(date(2026, 1, 2))[0] == "2026-01-02T00:00:00Z"
    assert day_slots(date(2026, 1, 2))[-1] == "2026-01-02T23:00:00Z"


def test_hourly_actuals_average_only_complete_half_hour_pairs():
    actuals = [
        {"start_time": "2026-01-02T00:00:00Z", "generation_mw": 100.0},
        {"start_time": "2026-01-02T00:30:00Z", "generation_mw": 200.0},
        {"start_time": "2026-01-02T01:00:00Z", "generation_mw": 300.0},
    ]
    assert aggregate_actuals_hourly(actuals) == {"2026-01-02T00:00:00Z": 150.0}


def test_select_forecasts_uses_latest_published_at_or_before_cutoff():
    forecasts = [
        {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-01T07:30:00Z", "generation_mw": 100.0},
        {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-01T09:30:00Z", "generation_mw": 110.0},
        {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-01T10:01:00Z", "generation_mw": 999.0},
    ]
    selected = select_forecasts(
        ["2026-01-02T00:00:00Z"], forecasts,
        datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
    )
    assert selected["2026-01-02T00:00:00Z"]["generation_mw"] == 110.0
    assert selected["2026-01-02T00:00:00Z"]["publish_time"] <= "2026-01-01T10:00:00Z"
    selected_0900 = select_forecasts(
        ["2026-01-02T00:00:00Z"], forecasts,
        datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
    )
    assert selected_0900["2026-01-02T00:00:00Z"]["publish_time"] == "2026-01-01T07:30:00Z"


def test_select_forecasts_excludes_hindsight_values():
    hindsight = {"start_time": "2026-01-01T21:00:00Z", "publish_time": "2026-01-02T02:30:00Z", "generation_mw": 900.0}
    assert select_forecasts(
        [hindsight["start_time"]], [hindsight], datetime(2026, 1, 3, tzinfo=timezone.utc)
    ) == {}


def test_select_forecasts_omits_interval_when_every_revision_is_after_cutoff():
    forecast = {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-01T10:01:00Z", "generation_mw": 999.0}
    assert select_forecasts([forecast["start_time"]], [forecast], datetime(2026, 1, 1, 10, tzinfo=timezone.utc)) == {}


def test_metrics_match_hand_calculation():
    # Errors are +2, -2, +4 MW; the zero actual is omitted from MAPE.
    result = calculate_metrics([(12.0, 10.0), (18.0, 20.0), (4.0, 0.0)])
    assert result["mae_mw"] == pytest.approx(8 / 3)
    assert result["rmse_mw"] == pytest.approx(math.sqrt(8))
    assert result["bias_mw"] == pytest.approx(4 / 3)
    assert result["mape_percent"] == pytest.approx(15.0)
    assert result["n_points"] == 3

