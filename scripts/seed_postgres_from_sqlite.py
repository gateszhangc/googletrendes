#!/usr/bin/env python3
import argparse
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import connect, ensure_schema, migrate_schema, normalize_database_url


DEFAULT_SQLITE = Path("data/google_trends.sqlite")

# Columns that must never receive NULL when the source database predates them.
TEXT_COLUMNS = {
    "path",
    "name",
    "sha256",
    "imported_at",
    "collected_date",
    "query_type",
    "geo",
    "category",
    "date_range",
    "query",
    "translation_original",
    "translation_ai",
    "change_label",
    "model",
    "updated_at",
}


def sqlite_rows(conn, table):
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(f"select * from {table} order by 1").fetchall()]


def cell(row, column):
    value = row.get(column)
    if value is None and column in TEXT_COLUMNS:
        return ""
    return value


def clear_postgres(conn):
    conn.execute("delete from trend_queries")
    conn.execute("delete from translation_cache")
    conn.execute("delete from source_files")


def insert_source_files(conn, rows):
    if not rows:
        return
    columns = ["id", "path", "name", "sha256", "mtime", "imported_at", "collected_date", "query_type"]
    with conn.cursor().copy(f"copy source_files ({', '.join(columns)}) from stdin") as copy:
        for row in rows:
            copy.write_row(tuple(cell(row, column) for column in columns))

def insert_translation_cache(conn, rows):
    if not rows:
        return
    columns = ["query", "translation_ai", "model", "updated_at"]
    with conn.cursor().copy(f"copy translation_cache ({', '.join(columns)}) from stdin") as copy:
        for row in rows:
            copy.write_row(tuple(cell(row, column) for column in columns))

def insert_trend_queries(conn, rows):
    if not rows:
        return
    columns = [
        "id",
        "source_file_id",
        "source_row",
        "geo",
        "category",
        "date_range",
        "query",
        "translation_original",
        "translation_ai",
        "change_label",
        "change_value",
        "change_is_breakout",
        "imported_at",
    ]
    with conn.cursor().copy(f"copy trend_queries ({', '.join(columns)}) from stdin") as copy:
        for row in rows:
            copy.write_row(tuple(cell(row, column) for column in columns))

def reset_sequences(conn):
    for table in ("source_files", "trend_queries"):
        conn.execute(
            "select setval(pg_get_serial_sequence(%s, 'id'), coalesce((select max(id) from "
            + table
            + "), 1), true)",
            (table,),
        )


def seed_from_sqlite(conn, sqlite_path, database_url=""):
    """Copy every row of the SQLite database into an (empty) Postgres database."""
    sqlite_path = Path(sqlite_path)
    if not sqlite_path.exists():
        raise SystemExit(f"sqlite source not found: {sqlite_path}")

    with sqlite3.connect(sqlite_path) as source:
        source_files = sqlite_rows(source, "source_files")
        trend_queries = sqlite_rows(source, "trend_queries")
        translation_cache = sqlite_rows(source, "translation_cache")

    clear_postgres(conn)
    insert_source_files(conn, source_files)
    insert_translation_cache(conn, translation_cache)
    insert_trend_queries(conn, trend_queries)
    reset_sequences(conn)
    migrate_schema(conn, database_url)
    return {
        "source_files": len(source_files),
        "trend_queries": len(trend_queries),
        "translation_cache": len(translation_cache),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    args = parser.parse_args()

    database_url = normalize_database_url(args.database_url)
    if not database_url:
        raise SystemExit("DATABASE_URL or --database-url is required")

    with connect(database_url=database_url) as target:
        ensure_schema(target, database_url)
        counts = seed_from_sqlite(target, args.sqlite, database_url)

    print(
        f"seeded source_files={counts['source_files']} "
        f"trend_queries={counts['trend_queries']} "
        f"translation_cache={counts['translation_cache']}"
    )


if __name__ == "__main__":
    main()
