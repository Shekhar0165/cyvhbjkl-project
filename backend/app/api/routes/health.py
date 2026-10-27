from fastapi import APIRouter, Request

from app.config.settings import settings
from app.data_access.database import row_counts
from app.schemas.responses import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["health"], summary="Check API and database readiness")
def health_check(request: Request) -> dict:
    counts = row_counts(request.app.state.database_path)
    empty = counts["actuals"] == 0 and counts["forecasts"] == 0
    warning = (
        "WARNING: database is empty; ingest the Elexon snapshot before using analytics."
        if empty else
        "WARNING: forecast table is empty; forecast analytics will return no-data responses."
        if counts["forecasts"] == 0 else None
    )
    return {
        "status": "ok", "database": "empty" if empty else "ok", "rows": counts,
        "version": settings.app_version,
        "message": warning or "Forecast and actual analytics use the local SQLite snapshot; no Elexon requests are made at runtime.",
    }
