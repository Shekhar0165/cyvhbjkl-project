import logging
import logging.config
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes.analytics import JAN_END, JAN_START, range_points, router as analytics_router
from app.api.routes.health import router as health_router
from app.api.routes.procurement import router as procurement_router
from app.config.settings import settings
from app.data_access.database import initialize_database, row_counts


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return (
            '{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s",'
            '"message":"%(message)s"}' % {
                "asctime": self.formatTime(record, self.datefmt), "levelname": record.levelname,
                "name": record.name, "message": record.getMessage().replace('"', '\\"'),
            }
        )


logging.basicConfig(level=settings.log_level.upper(), handlers=[logging.StreamHandler()])
for handler in logging.getLogger().handlers:
    handler.setFormatter(JsonFormatter())
logger = logging.getLogger("winddesk")


def _warm_default_analytics_cache(database_path: str) -> None:
    try:
        range_points(database_path, JAN_START, JAN_END, settings.default_cutoff_utc)
        logger.info("default-cutoff analytics cache warmed cutoff=%s", settings.default_cutoff_utc)
    except Exception:
        logger.exception("default-cutoff analytics cache warm failed")


def create_app(database_path: str | None = None) -> FastAPI:
    chosen_database_path = str(Path(database_path or settings.database_path).expanduser().resolve())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        Path(chosen_database_path).parent.mkdir(parents=True, exist_ok=True)
        initialize_database(chosen_database_path)
        app.state.database_path = chosen_database_path
        counts = row_counts(chosen_database_path)
        logger.info(
            "database ready path=%s rows_actuals=%d rows_forecasts=%d",
            chosen_database_path, counts["actuals"], counts["forecasts"],
        )
        if counts["actuals"] == 0 and counts["forecasts"] == 0:
            logger.warning("database is empty path=%s; ingest Elexon data before using analytics", chosen_database_path)
        elif counts["forecasts"] == 0:
            logger.warning("forecast table is empty path=%s; forecast analytics will report unavailable", chosen_database_path)
        threading.Thread(
            target=_warm_default_analytics_cache, args=(chosen_database_path,),
            name="winddesk-analytics-cache", daemon=True,
        ).start()
        yield

    application = FastAPI(
        title="WindDesk | UK Wind Forecast Decision Analytics",
        description=(
            "Decision-time analytics for national UK wind generation forecasts. Selects the latest "
            "forecast revision available by the configured day-ahead cutoff and compares it with actual generation. "
            "Analytics use the locally stored Elexon SQLite snapshot. "
            "The default 10:00 UTC cutoff is an assumption, not a verified market gate closure."
        ),
        version=settings.app_version,
        openapi_tags=[
            {"name": "health", "description": "Service and local database readiness."},
            {"name": "wind analytics", "description": "January 2026 decision-time forecast and error analytics."},
            {"name": "procurement", "description": "Demand-input wind-aware purchasing plans and walk-forward backtests."},
        ],
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=False,
        allow_methods=["GET", "POST"], allow_headers=["*"],
    )
    application.state.database_path = chosen_database_path
    request_times: dict[str, deque[float]] = defaultdict(deque)

    @application.middleware("http")
    async def in_memory_rate_limit(request: Request, call_next):
        now = time.monotonic()
        client = request.client.host if request.client else "unknown"
        recent = request_times[client]
        while recent and recent[0] <= now - 60:
            recent.popleft()
        if len(recent) >= 240:
            return JSONResponse(
                status_code=429, content={"detail": "Rate limit exceeded; try again shortly."},
                headers={"Retry-After": "60"},
            )
        recent.append(now)
        return await call_next(request)

    @application.middleware("http")
    async def utf8_json_charset(request: Request, call_next):
        response = await call_next(request)
        content_type = response.headers.get("content-type", "")
        if content_type.startswith("application/json") and "charset=" not in content_type.lower():
            response.headers["content-type"] = f"{content_type}; charset=utf-8"
        return response

    application.include_router(health_router)
    application.include_router(analytics_router, prefix="/api/v1")
    application.include_router(procurement_router, prefix="/api/v1")

    return application


app = create_app()
