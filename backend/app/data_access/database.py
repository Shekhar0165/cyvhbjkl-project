import sqlite3
from functools import lru_cache
from threading import RLock
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS actuals (
    start_time TEXT PRIMARY KEY,
    generation_mw REAL NOT NULL,
    settlement_date TEXT,
    settlement_period INTEGER
);
CREATE TABLE IF NOT EXISTS forecasts (
    start_time TEXT NOT NULL,
    publish_time TEXT NOT NULL,
    generation_mw REAL NOT NULL,
    PRIMARY KEY (start_time, publish_time)
);
CREATE INDEX IF NOT EXISTS idx_forecasts_start_publish ON forecasts(start_time, publish_time);
CREATE INDEX IF NOT EXISTS idx_forecasts_publish ON forecasts(publish_time);
CREATE INDEX IF NOT EXISTS idx_actuals_settlement_start ON actuals(settlement_date, start_time);
CREATE TABLE IF NOT EXISTS dataset_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""
_SNAPSHOT_LOCK = RLock()


def connect(database_path: str) -> sqlite3.Connection:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path), timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def connect_readonly(database_path: str) -> sqlite3.Connection:
    """Open a per-operation read-only connection with bounded lock waiting."""
    uri = f"{Path(database_path).expanduser().resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def initialize_database(database_path: str) -> None:
    with connect(database_path) as connection:
        connection.executescript(SCHEMA)


def row_counts(database_path: str) -> dict[str, int]:
    with connect_readonly(database_path) as connection:
        actuals = connection.execute("SELECT COUNT(*) FROM actuals").fetchone()[0]
        forecasts = connection.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0]
    return {"actuals": actuals, "forecasts": forecasts}


def read_actuals(database_path: str, start: date, end: date) -> list[dict]:
    """Read stored half-hour actuals in an inclusive settlement-date range."""
    with connect_readonly(database_path) as connection:
        rows = connection.execute(
            "SELECT start_time, generation_mw, settlement_date, settlement_period FROM actuals "
            "WHERE settlement_date >= ? AND settlement_date <= ? ORDER BY start_time", (start.isoformat(), end.isoformat())
        ).fetchall()
    return [dict(row) for row in rows]


def read_forecasts(database_path: str, start: date, end: date) -> list[dict]:
    """Read stored forecast revisions by their hourly target date, inclusive."""
    lower = datetime.combine(start, time.min, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    upper = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with connect_readonly(database_path) as connection:
        rows = connection.execute(
            "SELECT start_time, publish_time, generation_mw FROM forecasts "
            "WHERE start_time >= ? AND start_time < ? ORDER BY start_time, publish_time", (lower, upper)
        ).fetchall()
    return [dict(row) for row in rows]


@lru_cache(maxsize=16)
def _cached_snapshot(
    database_path: str, modified_ns: int, file_size: int, start: date, end: date,
) -> tuple[tuple[dict, ...], tuple[dict, ...]]:
    """Keep a read snapshot in memory; file metadata invalidates it after ingestion."""
    del modified_ns, file_size
    return (
        tuple(read_actuals(database_path, start, end)),
        tuple(read_forecasts(database_path, start, end)),
    )


def cached_snapshot(database_path: str, start: date, end: date) -> tuple[tuple[dict, ...], tuple[dict, ...]]:
    """Return a cached, immutable-by-convention snapshot for the requested date window."""
    stat = Path(database_path).stat()
    with _SNAPSHOT_LOCK:
        return _cached_snapshot(database_path, stat.st_mtime_ns, stat.st_size, start, end)


def upsert_actuals(database_path: str, rows: list[tuple]) -> int:
    with connect(database_path) as connection:
        if rows:
            _mark_elexon_source(connection)
        connection.executemany(
            "INSERT INTO actuals(start_time,generation_mw,settlement_date,settlement_period) "
            "VALUES(?,?,?,?) ON CONFLICT(start_time) DO UPDATE SET "
            "generation_mw=excluded.generation_mw,settlement_date=excluded.settlement_date,"
            "settlement_period=excluded.settlement_period", rows
        )
    return len(rows)


def upsert_forecasts(database_path: str, rows: list[tuple]) -> int:
    """Idempotently store forecast revisions, keyed by target and publication time."""
    with connect(database_path) as connection:
        if rows:
            _mark_elexon_source(connection)
        connection.executemany(
            "INSERT INTO forecasts(start_time,publish_time,generation_mw) VALUES(?,?,?) "
            "ON CONFLICT(start_time,publish_time) DO UPDATE SET generation_mw=excluded.generation_mw",
            rows,
        )
    return len(rows)


def _mark_elexon_source(connection: sqlite3.Connection) -> None:
    connection.execute("INSERT INTO dataset_state(key,value) VALUES('source','elexon') "
                       "ON CONFLICT(key) DO UPDATE SET value='elexon'")
