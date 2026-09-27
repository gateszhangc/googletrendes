#!/usr/bin/env python3
"""Fill missing AI translations for a Google Trends database.

Works against the local SQLite file (default) or any Postgres URL, reusing the
shared ``trends_translate`` module so the ingest endpoint and this CLI behave the
same way.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import connect, driver_name
from trends_translate import (
    apply_cache_to_rows,
    pending_queries,
    provider_config,
    save_translations,
    translate_queries,
)


DEFAULT_DB = Path("data/google_trends.sqlite")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--database-url", default="")
    parser.add_argument("--batch-size", type=int, default=60)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.2, help="kept for CLI compatibility")
    args = parser.parse_args()

    config = provider_config()
    if not config:
        raise SystemExit(
            "no translation credentials configured (set DEEPSEEK_API_KEY or ANTHROPIC_AUTH_TOKEN)"
        )

    database_url = args.database_url
    conn = connect(args.db, database_url)
    queries = pending_queries(conn, database_url, args.limit)
    print(
        f"pending unique queries={len(queries)} provider={config['name']} model={config['model']} "
        f"driver={driver_name(database_url)}",
        flush=True,
    )

    translated = 0
    for offset in range(0, len(queries), args.batch_size):
        batch = queries[offset : offset + args.batch_size]
        mapping = translate_queries(batch, config)
        with conn:
            save_translations(conn, database_url, mapping, config["model"])
            apply_cache_to_rows(conn, database_url)
        translated += len(mapping)
        print(f"translated {translated}/{len(queries)}", flush=True)

    print(f"done translated={translated} pending={max(len(queries) - translated, 0)}")


if __name__ == "__main__":
    main()
