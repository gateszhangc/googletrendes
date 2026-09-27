#!/usr/bin/env python3
import argparse
import csv
import hashlib
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from trends_db import migrate_schema


DEFAULT_INPUT_DIR = Path("2026-06-04")
DEFAULT_DB = Path("data/google_trends.sqlite")
TYPES = ("top", "rising")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_metadata(path):
    """Return (collected_date, query_type) for a google_trends_<type>_<date>*.tsv file."""
    match = re.match(r"google_trends_(top|rising)_(\d{4}-\d{2}-\d{2})", Path(path).name)
    if not match:
        return "", ""
    return match.group(2), match.group(1)


def parse_change(value):
    raw = (value or "").strip()
    if not raw:
        return None, 0
    if raw in {"飙升", "暴增", "Breakout", "breakout"}:
        return None, 1
    match = re.search(r"(-\s*)?([\d,.]+)", raw)
    if not match:
        return None, 0
    sign = -1 if match.group(1) else 1
    digits = match.group(2).replace(",", "")
    if re.fullmatch(r"\d+\.\d+", digits):
        return sign * int(float(digits)), 0
    return sign * int(digits.replace(".", "")), 0


def connect(db_path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("pragma journal_mode=wal")
    conn.execute("pragma foreign_keys=on")
    conn.executescript(
        """
        create table if not exists source_files (
          id integer primary key,
          path text not null unique,
          name text not null,
          sha256 text not null,
          mtime real not null,
          imported_at text not null,
          collected_date text not null default '',
          query_type text not null default ''
        );

        create table if not exists trend_queries (
          id integer primary key,
          source_file_id integer not null references source_files(id) on delete cascade,
          source_row integer not null,
          geo text not null,
          category text not null,
          date_range text not null,
          query text not null,
          translation_original text not null default '',
          translation_ai text not null default '',
          change_label text not null default '',
          change_value integer,
          change_is_breakout integer not null default 0,
          imported_at text not null,
          unique(source_file_id, source_row)
        );

        create table if not exists translation_cache (
          query text primary key,
          translation_ai text not null,
          model text not null,
          updated_at text not null
        );

        create index if not exists idx_trend_geo on trend_queries(geo);
        create index if not exists idx_trend_category on trend_queries(category);
        create index if not exists idx_trend_change_value on trend_queries(change_value);
        create index if not exists idx_trend_query on trend_queries(query);
        """
    )
    migrate_schema(conn)
    return conn


def import_file(conn, path):
    now = utc_now()
    digest = sha256_file(path)
    stat = path.stat()
    collected_date, query_type = source_metadata(path)
    conn.execute(
        """
        insert into source_files(path, name, sha256, mtime, imported_at, collected_date, query_type)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(path) do update set
          name=excluded.name,
          sha256=excluded.sha256,
          mtime=excluded.mtime,
          imported_at=excluded.imported_at,
          collected_date=excluded.collected_date,
          query_type=excluded.query_type
        """,
        (str(path), path.name, digest, stat.st_mtime, now, collected_date, query_type),
    )
    source_file_id = conn.execute(
        "select id from source_files where path = ?",
        (str(path),),
    ).fetchone()[0]

    conn.execute("delete from trend_queries where source_file_id = ?", (source_file_id,))
    rows = 0
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        expected = {"geo", "cat", "date", "query", "translation", "change"}
        if set(reader.fieldnames or []) != expected:
            raise ValueError(f"{path} fields mismatch: {reader.fieldnames}")
        for index, row in enumerate(reader, start=1):
            query = (row.get("query") or "").strip()
            if not query:
                continue
            change_value, change_is_breakout = parse_change(row.get("change"))
            conn.execute(
                """
                insert into trend_queries(
                  source_file_id, source_row, geo, category, date_range, query,
                  translation_original, translation_ai, change_label, change_value,
                  change_is_breakout, imported_at
                )
                values (?, ?, ?, ?, ?, ?, ?, coalesce((
                  select translation_ai from translation_cache where query = ?
                ), ''), ?, ?, ?, ?)
                """,
                (
                    source_file_id,
                    index,
                    (row.get("geo") or "").strip(),
                    (row.get("cat") or "").strip(),
                    (row.get("date") or "").strip(),
                    query,
                    (row.get("translation") or "").strip(),
                    query,
                    (row.get("change") or "").strip(),
                    change_value,
                    change_is_breakout,
                    now,
                ),
            )
            rows += 1
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", default=str(DEFAULT_INPUT_DIR))
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--date", default=None,
                        help="date string for file glob (e.g. 2026-06-25); defaults to input-dir name")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    date_pattern = args.date or input_dir.name
    files = sorted(
        file
        for query_type in TYPES
        for file in input_dir.glob(f"google_trends_{query_type}_{date_pattern}*.tsv")
    )
    if not files:
        raise SystemExit(
            f"no google_trends_top/rising TSV files matching {date_pattern} found in {input_dir}"
        )

    conn = connect(Path(args.db))
    total = 0
    with conn:
        for path in files:
            count = import_file(conn, path)
            total += count
            print(f"imported {count:5d} rows from {path}")

    summary = conn.execute(
        """
        select
          count(*) as rows,
          count(distinct query) as unique_queries,
          count(distinct geo) as geos,
          count(distinct category) as categories
        from trend_queries
        """
    ).fetchone()
    print(
        "summary rows={0} unique_queries={1} geos={2} categories={3}".format(*summary)
    )
    print(f"db={Path(args.db).resolve()}")


if __name__ == "__main__":
    main()
