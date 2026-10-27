from datetime import date

from fastapi.testclient import TestClient

from app.api.routes import analytics, procurement
from app.data_access.database import initialize_database
from app.main import create_app


def _actuals():
    return [
        {"start_time": f"2026-01-02T{hour:02d}:{minute:02d}:00Z",
         "generation_mw": (100.0 + hour if minute == 0 else 200.0 + hour),
         "settlement_date": "2026-01-02", "settlement_period": hour * 2 + minute // 30 + 1}
        for hour in range(24) for minute in (0, 30)
    ]


def _forecasts():
    rows = [
        {"start_time": f"2026-01-02T{hour:02d}:00:00Z", "publish_time": "2026-01-01T09:30:00Z",
         "generation_mw": 151.0 + hour}
        for hour in range(24)
    ]
    rows.extend([
        {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-01T11:30:00Z", "generation_mw": 999.0},
        {"start_time": "2026-01-02T00:00:00Z", "publish_time": "2026-01-02T02:30:00Z", "generation_mw": 9999.0},
    ])
    return rows


def test_api_reads_snapshot_plan_and_validates_inputs(tmp_path, monkeypatch):
    database = tmp_path / "test.db"
    initialize_database(str(database))
    actual_rows = _actuals()
    forecast_rows = _forecasts()
    monkeypatch.setattr(analytics, "read_actuals", lambda *_: actual_rows)
    monkeypatch.setattr(analytics, "read_forecasts", lambda *_: forecast_rows)
    monkeypatch.setattr(procurement, "read_actuals", lambda *_: actual_rows)
    monkeypatch.setattr(procurement, "read_forecasts", lambda *_: forecast_rows)
    app = create_app(str(database))

    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["database"] == "empty"
        assert health.json()["rows"]["forecasts"] == 0
        assert "WARNING: database is empty" in health.json()["message"]

        meta = client.get("/api/v1/meta")
        assert len(meta.json()["decision_dates"]) == 31
        assert meta.json()["available_decision_dates"][0] == "2026-01-01"
        assert meta.json()["data_source"] == "Elexon BMRS Insights API records stored in local SQLite"

        forecast = client.get("/api/v1/forecast", params={"decision_date": "2026-01-01", "cutoff": "10:00"})
        assert forecast.status_code == 200
        assert forecast.json()["data_available"] is True
        assert forecast.json()["summary"]["n_used"] == 24
        assert len(forecast.json()["points"]) == 24
        assert forecast.json()["points"][0]["actual_mw"] == 150.0
        assert forecast.json()["summary"]["publish_times"] == ["2026-01-01T09:30:00Z"]
        assert all(p["publish_time"] <= "2026-01-01T10:00:00Z" for p in forecast.json()["points"])

        no_data = client.get("/api/v1/forecast", params={"decision_date": "2026-01-08", "cutoff": "10:00"})
        assert no_data.status_code == 200
        assert no_data.json()["data_available"] is False
        assert "No forecast data available for this date" in no_data.json()["message"]

        evolution = client.get("/api/v1/forecast/evolution", params={"decision_date": "2026-01-01"})
        assert evolution.status_code == 200
        evolution_points = [p for batch in evolution.json()["batches"] for p in batch["points"]]
        assert all(p["start_time"].startswith("2026-01-02") for p in evolution_points)
        assert all(p["start_time"] >= p["publish_time"] for p in evolution_points)

        accuracy = client.get("/api/v1/accuracy", params={"from": "2026-01-01", "to": "2026-01-01"})
        assert accuracy.status_code == 200
        assert accuracy.json()["n_points"] == 24
        assert accuracy.json()["n_missing"] == 0

        horizon = client.get("/api/v1/accuracy/by-horizon", params={"from": "2026-01-01", "to": "2026-01-01"})
        assert sum(row["n_points"] for row in horizon.json()["data"]) == 25
        plan = client.post("/api/v1/procurement/plan", json={
            "decision_date": "2026-01-01", "cutoff": "10:00", "confidence": 0.9, "demand_mw": 30000,
        })
        assert plan.status_code == 200
        assert plan.json()["data_available"] is True
        assert len(plan.json()["hours"]) == 24
        assert plan.json()["calibration"]["status"] == "insufficient_history"
        list_plan = client.post("/api/v1/procurement/plan", json={
            "decision_date": "2026-01-01", "demand_mw": [30000] * 24,
        })
        assert list_plan.status_code == 200
        assert len(list_plan.json()["hours"]) == 24
        invalid_demand = client.post("/api/v1/procurement/plan", json={
            "decision_date": "2026-01-01", "demand_mw": [30000] * 23,
        })
        assert invalid_demand.status_code == 422
        for bad_value in ([30000] * 23 + [-1], [30000] * 23 + ["not-a-number"]):
            invalid = client.post("/api/v1/procurement/plan", json={
                "decision_date": "2026-01-01", "demand_mw": bad_value,
            })
            assert invalid.status_code == 422
        bad_date = client.post("/api/v1/procurement/plan", json={
            "decision_date": "2026-02-01", "demand_mw": 30000,
        })
        assert bad_date.status_code == 422

        invalid = client.get("/api/v1/forecast", params={"decision_date": "2026-01-01", "cutoff": "25:00"})
        assert invalid.status_code == 422
