#!/usr/bin/env python3
import argparse
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import connect, ensure_schema, normalize_database_url


DEFAULT_SQLITE = Path("data/google_trends.sqlite")


def sqlite_rows(conn, table):
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(f"select * from {table} order by 1").fetchall()]


def clear_postgres(conn):
    conn.execute("delete from trend_queries")
    conn.execute("delete from translation_cache")
    conn.execute("delete from source_files")


def insert_source_files(conn, rows):
    for row in rows:
        conn.execute(
            """
            insert into source_files(id, path, name, sha256, mtime, imported_at)
            values (%s, %s, %s, %s, %s, %s)
            on conflict(id) do update set
              path=excluded.path,
              name=excluded.name,
              sha256=excluded.sha256,
              mtime=excluded.mtime,
              imported_at=excluded.imported_at
            """,
            (
                row["id"],
                row["path"],
                row["name"],
                row["sha256"],
                row["mtime"],
                row["imported_at"],
            ),
        )


def insert_translation_cache(conn, rows):
    for row in rows:
        conn.execute(
            """
            insert into translation_cache(query, translation_ai, model, updated_at)
            values (%s, %s, %s, %s)
            on conflict(query) do update set
              translation_ai=excluded.translation_ai,
              model=excluded.model,
              updated_at=excluded.updated_at
            """,
            (
                row["query"],
                row["translation_ai"],
                row["model"],
                row["updated_at"],
            ),
        )


def insert_trend_queries(conn, rows):
    for row in rows:
        conn.execute(
            """
            insert into trend_queries(
              id, source_file_id, source_row, geo, category, date_range, query,
              translation_original, translation_ai, change_label, change_value,
              change_is_breakout, imported_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict(id) do update set
              source_file_id=excluded.source_file_id,
              source_row=excluded.source_row,
              geo=excluded.geo,
              category=excluded.category,
              date_range=excluded.date_range,
              query=excluded.query,
              translation_original=excluded.translation_original,
              translation_ai=excluded.translation_ai,
              change_label=excluded.change_label,
              change_value=excluded.change_value,
              change_is_breakout=excluded.change_is_breakout,
              imported_at=excluded.imported_at
            """,
            (
                row["id"],
                row["source_file_id"],
                row["source_row"],
                row["geo"],
                row["category"],
                row["date_range"],
                row["query"],
                row["translation_original"],
                row["translation_ai"],
                row["change_label"],
                row["change_value"],
                row["change_is_breakout"],
                row["imported_at"],
            ),
        )


def reset_sequences(conn):
    for table in ("source_files", "trend_queries"):
        conn.execute(
            "select setval(pg_get_serial_sequence(%s, 'id'), coalesce((select max(id) from "
            + table
            + "), 1), true)",
            (table,),
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    args = parser.parse_args()

    database_url = normalize_database_url(args.database_url)
    if not database_url:
        raise SystemExit("DATABASE_URL or --database-url is required")

    sqlite_path = Path(args.sqlite)
    if not sqlite_path.exists():
        raise SystemExit(f"sqlite source not found: {sqlite_path}")

    with sqlite3.connect(sqlite_path) as source:
        source_files = sqlite_rows(source, "source_files")
        trend_queries = sqlite_rows(source, "trend_queries")
        translation_cache = sqlite_rows(source, "translation_cache")

    with connect(database_url=database_url) as target:
        ensure_schema(target, database_url)
        clear_postgres(target)
        insert_source_files(target, source_files)
        insert_translation_cache(target, translation_cache)
        insert_trend_queries(target, trend_queries)
        reset_sequences(target)

    print(
        f"seeded source_files={len(source_files)} "
        f"trend_queries={len(trend_queries)} "
        f"translation_cache={len(translation_cache)}"
    )


if __name__ == "__main__":
    main()
