from app.data_access.database import connect, initialize_database, row_counts


def test_initialize_database_preserves_existing_rows(tmp_path):
    database = tmp_path / "test.db"
    initialize_database(str(database))
    with connect(str(database)) as connection:
        connection.execute(
            "INSERT INTO actuals(start_time,generation_mw,settlement_date,settlement_period) "
            "VALUES('2026-01-02T00:00:00Z',123.0,'2026-01-02',1)"
        )
        connection.execute(
            "INSERT INTO forecasts(start_time,publish_time,generation_mw) "
            "VALUES('2026-01-02T00:00:00Z','2026-01-01T09:30:00Z',456.0)"
        )

    initialize_database(str(database))

    assert row_counts(str(database)) == {"actuals": 1, "forecasts": 1}
