"""Resume-safe Elexon FUELHH and WINDFOR ingestion for the January 2026 snapshot."""

from __future__ import annotations

import argparse
import logging
import sqlite3
import time
from datetime import date, datetime, time as day_time, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from app.config.settings import settings
from app.data_access.database import initialize_database, row_counts, upsert_actuals, upsert_forecasts

BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"
UTC = timezone.utc
LOGGER = logging.getLogger("winddesk.ingest")


def parse_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "results", "result"):
            if isinstance(payload.get(key), list):
                return [row for row in payload[key] if isinstance(row, dict)]
    raise ValueError(f"Unexpected Elexon JSON response shape: {type(payload).__name__}")


def request_rows(client: httpx.Client, endpoint: str, params: dict[str, str]) -> list[dict[str, Any]]:
    url = f"{BASE_URL}/{endpoint}"
    last_error: Exception | None = None
    for attempt in range(1, 6):
        try:
            response = client.get(url, params=params)
            response.raise_for_status()
            return parse_records(response.json())
        except (httpx.HTTPError, ValueError) as error:
            last_error = error
            if attempt < 5:
                delay = min(2 ** (attempt - 1), 30)
                LOGGER.warning("retry endpoint=%s attempt=%d/5 delay_seconds=%d error=%s", endpoint, attempt, delay, error)
                time.sleep(delay)
    raise RuntimeError(f"{endpoint} failed after five attempts: {last_error}")


def actual_chunks(start: date, end: date, chunk_days: int = 3):
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=chunk_days - 1), end)
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


def fetch_actual_chunk(client: httpx.Client, start: date, end: date) -> list[tuple]:
    rows = request_rows(client, "datasets/FUELHH/stream", {
        "settlementDateFrom": start.isoformat(),
        "settlementDateTo": end.isoformat(),
        "fuelType": "WIND",
    })
    result = []
    for row in rows:
        if str(row.get("fuelType", "")).upper() != "WIND":
            continue
        start_time, generation = row.get("startTime"), row.get("generation")
        if start_time is None or generation is None:
            continue
        result.append((str(start_time), float(generation), row.get("settlementDate"), row.get("settlementPeriod")))
    return result


def fetch_forecast_day(client: httpx.Client, publish_day: date) -> list[tuple]:
    start = datetime.combine(publish_day, day_time.min, tzinfo=UTC)
    end = datetime.combine(publish_day, day_time(23, 59, 59), tzinfo=UTC)
    rows = request_rows(client, "datasets/WINDFOR/stream", {
        "publishDateTimeFrom": start.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "publishDateTimeTo": end.isoformat(timespec="seconds").replace("+00:00", "Z"),
    })
    result = []
    for row in rows:
        start_time, publish_time, generation = row.get("startTime"), row.get("publishTime"), row.get("generation")
        if start_time is None or publish_time is None or generation is None:
            continue
        published = datetime.fromisoformat(str(publish_time).replace("Z", "+00:00")).astimezone(UTC)
        if published.date() != publish_day:
            continue
        result.append((str(start_time), str(publish_time), float(generation)))
    return result


def replace_tables(database_path: str, only: str | None) -> None:
    """Explicit --replace operation. The caller prints the affected counts first."""
    with sqlite3.connect(database_path) as connection:
        if only in (None, "actuals"):
            connection.execute("DELETE FROM actuals")
        if only in (None, "forecasts"):
            connection.execute("DELETE FROM forecasts")


def run(args: argparse.Namespace) -> int:
    database_path = str(Path(args.database).expanduser().resolve())
    end = date.fromisoformat(args.end)
    start = date.fromisoformat(args.start)
    if start > end:
        raise ValueError("--start must be on or before --end")
    initialize_database(database_path)
    before = row_counts(database_path)
    if args.replace:
        deletions = {
            "actuals": before["actuals"] if args.only in (None, "actuals") else 0,
            "forecasts": before["forecasts"] if args.only in (None, "forecasts") else 0,
        }
        LOGGER.warning("--replace explicitly requested; rows to delete: %s", deletions)
        replace_tables(database_path, args.only)

    # The supplied --end is the inclusive actuals bound. Decision dates stop two days earlier.
    forecast_end = min(end - timedelta(days=2), date(2026, 1, 31))
    failures: list[tuple[str, date, date]] = []
    timeout = httpx.Timeout(90.0, connect=30.0)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        if args.only in (None, "actuals"):
            for chunk_start, chunk_end in actual_chunks(start, end):
                label = f"actuals {chunk_start}..{chunk_end}"
                try:
                    rows = fetch_actual_chunk(client, chunk_start, chunk_end)
                    upsert_actuals(database_path, rows)
                    LOGGER.info("%s: %d rows", label, len(rows))
                except Exception as error:
                    LOGGER.error("chunk failed %s: %s", label, error)
                    failures.append(("actuals", chunk_start, chunk_end))

        if args.only in (None, "forecasts") and start <= forecast_end:
            cursor = start
            while cursor <= forecast_end:
                try:
                    rows = fetch_forecast_day(client, cursor)
                    upsert_forecasts(database_path, rows)
                    LOGGER.info("forecasts %s: %d rows", cursor, len(rows))
                except Exception as error:
                    LOGGER.error("chunk failed forecasts %s: %s", cursor, error)
                    failures.append(("forecasts", cursor, cursor))
                cursor += timedelta(days=1)

        # One explicit end-of-run retry pass lets a transiently failing chunk recover.
        still_failed = []
        for kind, chunk_start, chunk_end in failures:
            try:
                if kind == "actuals":
                    rows = fetch_actual_chunk(client, chunk_start, chunk_end)
                    upsert_actuals(database_path, rows)
                else:
                    rows = fetch_forecast_day(client, chunk_start)
                    upsert_forecasts(database_path, rows)
                LOGGER.info("retry recovered %s %s..%s: %d rows", kind, chunk_start, chunk_end, len(rows))
            except Exception as error:
                LOGGER.error("retry failed %s %s..%s: %s", kind, chunk_start, chunk_end, error)
                still_failed.append((kind, chunk_start, chunk_end))

    after = row_counts(database_path)
    LOGGER.info("ingestion complete database=%s actuals=%d forecasts=%d", database_path, after["actuals"], after["forecasts"])
    if still_failed:
        LOGGER.error("chunks still failed: %s", still_failed)
        return 1
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Idempotently ingest Elexon January 2026 wind observations.")
    result.add_argument("--database", default=settings.database_path, help="SQLite path; defaults to the API DATABASE_PATH")
    result.add_argument("--start", default="2026-01-01", help="Inclusive actual settlement/publish date")
    result.add_argument("--end", default="2026-02-02", help="Inclusive actual settlement end; forecasts end two days earlier")
    result.add_argument("--only", choices=("actuals", "forecasts"), help="Ingest one dataset only")
    result.add_argument("--replace", action="store_true", help="Explicitly delete the selected existing table rows before ingestion")
    return result


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = parser().parse_args()
    try:
        raise SystemExit(run(args))
    except Exception as error:
        LOGGER.error("ingestion stopped: %s", error)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
