from datetime import date
from math import isfinite
from typing import Any, Literal
from pydantic import BaseModel, Field
from pydantic import field_validator


class HealthResponse(BaseModel):
    status: str = Field(examples=["ok"])
    database: str = Field(examples=["ok", "empty"])
    rows: dict[str, int] = Field(examples=[{"actuals": 1584, "forecasts": 18104}])
    version: str = Field(examples=["1.0.0"])
    message: str | None = None


class ForecastPoint(BaseModel):
    start_time: str = Field(examples=["2026-01-02T00:00:00Z"])
    forecast_mw: float | None = Field(examples=[8420.5])
    publish_time: str | None = Field(examples=["2026-01-01T09:30:00Z"])
    hours_ahead: float | None = Field(examples=[14.5])
    actual_mw: float | None = Field(examples=[8190.0])


class ForecastSummary(BaseModel):
    average_mw: float | None = Field(examples=[8100.0])
    peak_mw: float | None = Field(examples=[10400.0])
    peak_time: str | None = Field(examples=["2026-01-02T13:00:00Z"])
    publish_times: list[str]
    earliest_publish_time: str | None = None
    latest_publish_time: str | None = None
    hours_before_delivery: float | None = None
    n_used: int
    n_missing_forecast: int
    n_missing_actual: int


class ForecastResponse(BaseModel):
    data_available: bool = True
    message: str | None = None
    decision_date: str
    delivery_date: str
    cutoff: str
    cutoff_assumption: str
    points: list[ForecastPoint]
    summary: ForecastSummary


class EvolutionBatch(BaseModel):
    publish_time: str
    after_cutoff: bool
    points: list[ForecastPoint]


class EvolutionResponse(BaseModel):
    data_available: bool = True
    message: str | None = None
    decision_date: str
    delivery_date: str
    cutoff: str
    batches: list[EvolutionBatch]


class MetricPoint(BaseModel):
    start_time: str
    forecast_mw: float | None
    actual_mw: float | None
    error_mw: float | None


class AccuracyResponse(BaseModel):
    from_date: str
    to_date: str
    cutoff: str
    mae_mw: float | None = Field(examples=[125.4])
    rmse_mw: float | None = Field(examples=[180.2])
    bias_mw: float | None = Field(examples=[24.1])
    mape_percent: float | None = Field(examples=[2.8])
    n_points: int
    n_missing: int
    series: list[MetricPoint]


class MetaResponse(BaseModel):
    available_decision_dates: list[str]
    decision_dates: list[dict[str, Any]]
    default_cutoff_utc: str
    data_source: str
    coverage: dict[str, Any]
    assumptions: list[str]


class HistogramBin(BaseModel):
    from_mw: float
    to_mw: float
    count: int


class ErrorDistributionResponse(BaseModel):
    data: list[HistogramBin]
    n_points: int = Field(examples=[744])
    p5_mw: float | None = Field(examples=[-220.0])
    p50_mw: float | None = Field(examples=[18.0])
    p95_mw: float | None = Field(examples=[310.0])
    p95_absolute_error_mw: float | None = None


class GroupedMetricsResponse(BaseModel):
    data: list[dict[str, Any]]


class ProcurementPlanRequest(BaseModel):
    decision_date: date = Field(examples=["2026-01-15"])
    cutoff: str = Field(default="10:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$", examples=["10:00"])
    confidence: Literal[0.5, 0.8, 0.9, 0.95] = Field(default=0.9, examples=[0.9])
    demand_mw: float | list[float] = Field(examples=[30000.0, [30000.0] * 24])
    use_full_month_stats: bool = False

    model_config = {"json_schema_extra": {"examples": [{
        "decision_date": "2026-01-15", "cutoff": "10:00", "confidence": 0.9,
        "demand_mw": 30000, "use_full_month_stats": False,
    }]}}

    @field_validator("demand_mw")
    @classmethod
    def validate_demand(cls, value):
        values = value if isinstance(value, list) else [value]
        if isinstance(value, list) and len(value) != 24:
            raise ValueError("demand_mw must contain exactly 24 hourly values")
        if any(not isinstance(number, (int, float)) or not isfinite(number) or number < 0 for number in values):
            raise ValueError("demand_mw values must be numeric and greater than or equal to zero")
        return value


class ProcurementHour(BaseModel):
    hour_start: str
    demand_mw: float
    forecast_mw: float
    usable_wind_naive: float
    usable_wind_bias_adjusted: float
    usable_wind_risk_adjusted: float
    buy_naive_mw: float
    buy_bias_adjusted_mw: float
    buy_recommended_mw: float
    actual_wind_mw: float | None
    hindsight_needed_mw: float | None


class ProcurementCalibration(BaseModel):
    status: Literal["ok", "insufficient_history", "in_sample"]
    n_days: int
    n_points: int
    bias_mw: float | None
    quantile_mw: float | None
    confidence: float
    window: str


class ProcurementForecastBatch(BaseModel):
    publish_time: str | list[str] | None = Field(examples=["2026-01-15T09:30:00Z"])
    lead_hours: float | None = Field(examples=[14.5])


class ProcurementSummary(BaseModel):
    total_mwh_naive: float | None = Field(default=None, examples=[412000.0])
    total_mwh_recommended: float | None = Field(default=None, examples=[438000.0])
    average_mw: float | None = Field(default=None, examples=[18250.0])
    peak_mw: float | None = Field(default=None, examples=[24000.0])
    peak_hour: str | None = Field(default=None, examples=["2026-01-16T18:00:00Z"])
    extra_buffer_mwh: float | None = Field(default=None, examples=[26000.0])
    extra_buffer_percent: float | None = Field(default=None, examples=[6.3])


class ProcurementPlanResponse(BaseModel):
    data_available: bool
    message: str | None
    delivery_date: str
    forecast_batch: ProcurementForecastBatch
    calibration: ProcurementCalibration
    hours: list[ProcurementHour]
    summary: ProcurementSummary
    hindsight: dict[str, dict[str, float]] | None
    warnings: list[str]


class ProcurementBacktestResponse(BaseModel):
    from_date: str
    to_date: str
    cutoff: str
    confidence: float
    demand_mw: float
    demand_note: str
    n_days_evaluated: int
    n_hours_evaluated: int
    coverage: float | None
    target_coverage: float
    strategies: dict[str, dict[str, float | None]]
