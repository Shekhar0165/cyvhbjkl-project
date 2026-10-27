from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.api.routes.analytics import JAN_END, JAN_START, validate_january_day
from app.data_access.database import cached_snapshot, read_actuals, read_forecasts
from app.schemas.responses import ProcurementBacktestResponse, ProcurementPlanRequest, ProcurementPlanResponse
from app.services.procurement import backtest, build_plan, calibrate

router = APIRouter(prefix="/procurement", tags=["procurement"])
ALLOWED_CONFIDENCE = (0.5, 0.8, 0.9, 0.95)
def _load_snapshot(request: Request, start: date, end: date) -> tuple[list[dict], list[dict]]:
    database_path = request.app.state.database_path
    return cached_snapshot(database_path, start + timedelta(days=1), end + timedelta(days=1))


@lru_cache(maxsize=32)
def _cached_backtest(
    database_path: str, database_mtime_ns: int, database_size: int,
    from_date: date, to_date: date, cutoff: str, confidence: float, demand_mw: float,
) -> dict[str, Any]:
    """January is a fixed snapshot; cache repeat backtests and invalidate on DB changes."""
    del database_mtime_ns, database_size  # Included in the cache key for invalidation.
    actuals, forecasts = cached_snapshot(database_path, JAN_START + timedelta(days=1), JAN_END + timedelta(days=1))
    return backtest(from_date, to_date, cutoff, confidence, demand_mw, actuals, forecasts)


@lru_cache(maxsize=256)
def _cached_calibration(
    database_path: str, database_mtime_ns: int, database_size: int,
    decision_date: date, cutoff: str, confidence: float, use_full_month_stats: bool,
) -> dict[str, Any]:
    del database_mtime_ns, database_size
    actuals, forecasts = cached_snapshot(database_path, JAN_START + timedelta(days=1), JAN_END + timedelta(days=1))
    return calibrate(decision_date, cutoff, confidence, actuals, forecasts, use_full_month_stats)


@router.post(
    "/plan", response_model=ProcurementPlanResponse, summary="Calculate an hourly wind-aware purchase plan",
    description="Uses user-provided demand and the selected cutoff forecast, adjusted by historical decision-time errors.",
)
def create_plan(request: Request, body: ProcurementPlanRequest) -> dict[str, Any]:
    validate_january_day(body.decision_date, "decision_date")
    database_path = request.app.state.database_path
    stat = Path(database_path).stat()
    actuals, forecasts = _load_snapshot(request, JAN_START, JAN_END)
    calibration = _cached_calibration(
        database_path, stat.st_mtime_ns, stat.st_size, body.decision_date, body.cutoff,
        body.confidence, body.use_full_month_stats,
    )
    return build_plan(
        body.decision_date, body.cutoff, body.confidence, body.demand_mw,
        actuals, forecasts, body.use_full_month_stats, calibration,
    )


@router.get(
    "/backtest", response_model=ProcurementBacktestResponse, summary="Backtest the purchase strategies",
    description="Walks forward across January decision dates using only each date's eligible D-2 calibration history.",
)
def get_backtest(
    request: Request,
    from_date: date = Query(..., alias="from", description="First decision date in January 2026", examples=["2026-01-01"]),
    to_date: date = Query(..., alias="to", description="Last decision date in January 2026", examples=["2026-01-30"]),
    cutoff: str = Query("10:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="Decision cutoff in UTC"),
    confidence: float = Query(0.9, description="Target wind-error quantile: 0.5, 0.8, 0.9, or 0.95"),
    demand_mw: float = Query(30000, ge=0, description="Flat user-supplied demand assumption in MW"),
) -> dict[str, Any]:
    if from_date > to_date:
        raise HTTPException(status_code=422, detail="from must be on or before to")
    validate_january_day(from_date, "from")
    validate_january_day(to_date, "to")
    if confidence not in ALLOWED_CONFIDENCE:
        raise HTTPException(status_code=422, detail="confidence must be one of 0.5, 0.8, 0.9, or 0.95")
    database_path = request.app.state.database_path
    stat = Path(database_path).stat()
    return _cached_backtest(
        database_path, stat.st_mtime_ns, stat.st_size,
        from_date, to_date, cutoff, confidence, demand_mw,
    )
