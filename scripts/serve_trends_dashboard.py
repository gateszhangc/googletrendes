#!/usr/bin/env python3
import argparse
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import connect, driver_name, ensure_schema, placeholder
from trends_translate import provider_config, translate_source_file


DEFAULT_DB = Path("data/google_trends.sqlite")
DEFAULT_WEB = Path("web")
MAX_INGEST_BYTES = 8 * 1024 * 1024


class IngestError(Exception):
    """Raised for malformed ingest payloads (HTTP 400)."""


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


class TrendsHandler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB
    database_url = ""
    web_root = DEFAULT_WEB
    ingest_token = ""

    def log_message(self, format, *args):
        return

    def db(self):
        return connect(self.db_path, self.database_url)

    def collected_date_sql(self, alias="sf"):
        if self.database_url:
            legacy = f"substring({alias}.name from 22 for 10)"
        else:
            legacy = f"substr({alias}.name, 22, 10)"
        return f"coalesce(nullif({alias}.collected_date, ''), {legacy})"

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        origin = self.headers.get("origin")
        if origin:
            self.send_header("access-control-allow-origin", origin)
            self.send_header("vary", "origin")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            return self.healthz()
        if parsed.path == "/api/summary":
            return self.api_summary()
        if parsed.path == "/api/facets":
            return self.api_facets()
        if parsed.path == "/api/trends":
            return self.api_trends(parse_qs(parsed.query))
        if parsed.path == "/api/chart":
            return self.api_chart()

        relative = parsed.path.lstrip("/") or "index.html"
        if ".." in Path(relative).parts:
            self.send_error(400)
            return
        self.send_file(self.web_root / relative)

    def do_OPTIONS(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/ingest":
            return self.send_json({"ok": False, "error": "not found"}, status=404)
        self.send_response(204)
        self.send_header("access-control-allow-origin", self.headers.get("origin") or "*")
        self.send_header("access-control-allow-methods", "POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type, authorization")
        self.send_header("access-control-max-age", "600")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/ingest":
            return self.send_json({"ok": False, "error": "not found"}, status=404)
        if not self.ingest_token:
            return self.send_json({"ok": False, "error": "ingest disabled"}, status=503)

        header = self.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not token or not secrets.compare_digest(token, self.ingest_token):
            return self.send_json({"ok": False, "error": "unauthorized"}, status=401)

        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self.send_json({"ok": False, "error": "empty body"}, status=400)
        if length > MAX_INGEST_BYTES:
            return self.send_json({"ok": False, "error": "body too large"}, status=413)

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as error:
            return self.send_json({"ok": False, "error": f"invalid json: {error}"}, status=400)
        if not isinstance(payload, dict):
            return self.send_json({"ok": False, "error": "payload must be an object"}, status=400)

        try:
            result = self.ingest_batch(payload)
        except IngestError as error:
            return self.send_json({"ok": False, "error": str(error)}, status=400)
        except Exception as error:
            return self.send_json(
                {"ok": False, "error": f"{type(error).__name__}: {error}"}, status=500
            )
        self.send_json(result)

    def clean_rows(self, rows):
        cleaned = []
        seen = set()
        for entry in rows:
            if isinstance(entry, dict):
                query = str(entry.get("query") or "").strip()
                change = str(entry.get("change") or "").strip()
            else:
                query = str(entry or "").strip()
                change = ""
            if not query or query in seen:
                continue
            seen.add(query)
            cleaned.append({"query": query, "change": change})
        return cleaned

    def build_tsv(self, geo, category, date_range, rows):
        lines = ["geo\tcat\tdate\tquery\ttranslation\tchange"]
        for item in rows:
            values = [geo, category, date_range, item["query"], "", item["change"]]
            lines.append("\t".join(value.replace("\t", " ").replace("\n", " ") for value in values))
        return "\n".join(lines) + "\n"

    def unique_source_name(self, conn, query_type, collected_date, term):
        base = f"google_trends_{query_type}_{collected_date}"
        if term:
            slug = re.sub(r"[^\w.\-]+", "_", term, flags=re.UNICODE)[:40].strip("_")
            if slug:
                base = f"{base}_{slug}"
        mark = placeholder(self.database_url)
        for index in range(1000):
            suffix = "" if index == 0 else f"_{index:02d}"
            candidate = f"{base}{suffix}.tsv"
            found = conn.execute(
                f"select 1 from source_files where name = {mark}", (candidate,)
            ).fetchone()
            if not found:
                return candidate
        raise IngestError("too many files share this name")

    def ingest_batch(self, payload):
        batch = payload.get("batch") if isinstance(payload.get("batch"), dict) else {}
        rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []

        query_type = str(batch.get("type") or "").strip().lower()
        if query_type not in {"top", "rising"}:
            raise IngestError("batch.type must be 'top' or 'rising'")
        geo = str(batch.get("geo") or "").strip().upper() or "GLOBAL"
        category = str(batch.get("category") or "").strip()
        if not category:
            raise IngestError("batch.category is required")
        date_range = str(batch.get("date_range") or "").strip() or "now 7-d"
        collected_date = str(batch.get("collected_date") or "").strip() or datetime.now(
            timezone.utc
        ).strftime("%Y-%m-%d")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", collected_date):
            raise IngestError("batch.collected_date must look like YYYY-MM-DD")
        term = str(batch.get("term") or "").strip()

        cleaned = self.clean_rows(rows)
        if not cleaned:
            raise IngestError("rows must contain at least one query")

        tsv = self.build_tsv(geo, category, date_range, cleaned)
        # The seed term is not part of the TSV columns, but two terms must not collapse
        # into one upload, so include it in the content identity.
        digest_source = tsv if not term else f"{tsv}\n#term={term}\n"
        digest = hashlib.sha256(digest_source.encode("utf-8")).hexdigest()
        mark = placeholder(self.database_url)

        with self.db() as conn:
            existing = conn.execute(
                f"select name, path from source_files where sha256 = {mark}", (digest,)
            ).fetchone()
            if existing:
                row = dict(existing)
                return {
                    "ok": True,
                    "deduped": True,
                    "source_file": row["name"],
                    "path": row["path"],
                    "sha256": digest,
                    "inserted": 0,
                    "translated": 0,
                    "pending_translation": 0,
                }

            name = self.unique_source_name(conn, query_type, collected_date, term)
            path = f"upload/{collected_date}/{digest}.tsv"
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            conn.execute(
                f"""
                insert into source_files(path, name, sha256, mtime, imported_at, collected_date, query_type)
                values ({mark}, {mark}, {mark}, {mark}, {mark}, {mark}, {mark})
                """,
                (path, name, digest, time.time(), now, collected_date, query_type),
            )
            source_row = conn.execute(
                f"select id from source_files where path = {mark}", (path,)
            ).fetchone()
            source_file_id = source_row["id"] if isinstance(source_row, dict) else source_row[0]

            for index, item in enumerate(cleaned, start=1):
                change_value, change_is_breakout = parse_change(item["change"])
                conn.execute(
                    f"""
                    insert into trend_queries(
                      source_file_id, source_row, geo, category, date_range, query,
                      translation_original, translation_ai, change_label, change_value,
                      change_is_breakout, imported_at
                    )
                    values (
                      {mark}, {mark}, {mark}, {mark}, {mark}, {mark}, '',
                      coalesce((select translation_ai from translation_cache where query = {mark}), ''),
                      {mark}, {mark}, {mark}, {mark}
                    )
                    """,
                    (
                        source_file_id,
                        index,
                        geo,
                        category,
                        date_range,
                        item["query"],
                        item["query"],
                        item["change"],
                        change_value,
                        change_is_breakout,
                        now,
                    ),
                )

            translated, pending = translate_source_file(conn, self.database_url, source_file_id)

        return {
            "ok": True,
            "deduped": False,
            "source_file": name,
            "path": path,
            "sha256": digest,
            "inserted": len(cleaned),
            "translated": translated,
            "pending_translation": pending,
        }

    def healthz(self):
        try:
            with self.db() as conn:
                rows = conn.execute("select count(*) as rows from trend_queries").fetchone()["rows"]
            self.send_json({"ok": True, "database": driver_name(self.database_url), "rows": rows})
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=503)

    def api_summary(self):
        params = parse_qs(urlparse(self.path).query)
        where, values = self.date_clause(params, "sf")
        clause = f"where {' and '.join(where)}" if where else ""
        with self.db() as conn:
            summary = conn.execute(
                f"""
                select
                  count(*) as rows,
                  count(distinct query) as unique_queries,
                  count(distinct geo) as geos,
                  count(distinct category) as categories,
                  sum(case when change_is_breakout = 1 then 1 else 0 end) as breakouts,
                  sum(case when coalesce(translation_ai, '') <> '' then 1 else 0 end) as translated_rows
                from trend_queries tq
                join source_files sf on sf.id = tq.source_file_id
                {clause}
                """,
                values,
            ).fetchone()
            files = conn.execute(
                f"""
                select count(distinct sf.id) as files
                from source_files sf
                join trend_queries tq on tq.source_file_id = sf.id
                {clause}
                """,
                values,
            ).fetchone()["files"]
            summary["files"] = files
            summary["translated_rate"] = round(
                (summary["translated_rows"] or 0) / summary["rows"] * 100, 1
            ) if summary["rows"] else 0
            self.send_json(summary)

    def api_facets(self):
        date_expr = self.collected_date_sql("sf")
        with self.db() as conn:
            collected_dates = conn.execute(
                f"""
                select {date_expr} as value, count(*) as count
                from trend_queries tq
                join source_files sf on sf.id = tq.source_file_id
                group by value
                order by value desc
                """
            ).fetchall()
            latest_collected_date = collected_dates[0]["value"] if collected_dates else ""
            geos = conn.execute(
                "select geo as value, count(*) as count from trend_queries group by geo order by count desc, geo"
            ).fetchall()
            categories = conn.execute(
                "select category as value, count(*) as count from trend_queries group by category order by count desc, category"
            ).fetchall()
            dates = conn.execute(
                "select date_range as value, count(*) as count from trend_queries group by date_range order by value"
            ).fetchall()
            types = conn.execute(
                """
                select coalesce(nullif(sf.query_type, ''), 'rising') as value, count(*) as count
                from trend_queries tq
                join source_files sf on sf.id = tq.source_file_id
                group by value
                order by count desc, value
                """
            ).fetchall()
            self.send_json({
                "geos": geos,
                "categories": categories,
                "dates": dates,
                "types": types,
                "collected_dates": collected_dates,
                "latest_collected_date": latest_collected_date,
            })

    def api_chart(self):
        params = parse_qs(urlparse(self.path).query)
        where, values = self.date_clause(params, "sf")
        clause = f"where {' and '.join(where)}" if where else ""
        with self.db() as conn:
            by_geo = conn.execute(
                f"""
                select geo as label, count(*) as value
                from trend_queries tq
                join source_files sf on sf.id = tq.source_file_id
                {clause}
                group by geo
                order by value desc, geo
                limit 12
                """,
                values,
            ).fetchall()
            by_category = conn.execute(
                f"""
                select category as label, count(*) as value
                from trend_queries tq
                join source_files sf on sf.id = tq.source_file_id
                {clause}
                group by category
                order by value desc, category
                limit 12
                """,
                values,
            ).fetchall()
            self.send_json({"by_geo": by_geo, "by_category": by_category})

    def date_clause(self, params, source_alias):
        value = (params.get("collected_date", [""])[0] or "").strip()
        if not value:
            return [], []
        return [f"{self.collected_date_sql(source_alias)} = {placeholder(self.database_url)}"], [value]

    def api_trends(self, params):
        where, values = self.date_clause(params, "sf")
        unique = (params.get("unique", [""])[0] or "").strip() == "yes"

        search = (params.get("search", [""])[0] or "").strip()
        if search:
            mark = placeholder(self.database_url)
            where.append(
                f"(lower(query) like lower({mark}) or "
                f"lower(translation_original) like lower({mark}) or "
                f"lower(translation_ai) like lower({mark}))"
            )
            token = f"%{search}%"
            values.extend([token, token, token])

        for key, column in [("geo", "geo"), ("category", "category"), ("date", "date_range")]:
            value = (params.get(key, [""])[0] or "").strip()
            if value:
                where.append(f"{column} = {placeholder(self.database_url)}")
                values.append(value)

        query_type = (params.get("type", [""])[0] or "").strip()
        if query_type:
            where.append(
                f"coalesce(nullif(sf.query_type, ''), 'rising') = {placeholder(self.database_url)}"
            )
            values.append(query_type)

        translated = (params.get("translated", [""])[0] or "").strip()
        if translated == "yes":
            where.append("coalesce(translation_ai, '') <> ''")
        elif translated == "no":
            where.append("coalesce(translation_ai, '') = ''")

        change = (params.get("change", [""])[0] or "").strip()
        if change == "breakout":
            where.append("change_is_breakout = 1")
        elif change == "percent":
            where.append("change_value is not null")

        clause = f"where {' and '.join(where)}" if where else ""
        limit = min(max(int(params.get("limit", ["80"])[0] or 80), 1), 300)
        offset = max(int(params.get("offset", ["0"])[0] or 0), 0)
        mark = placeholder(self.database_url)

        with self.db() as conn:
            if unique:
                total = conn.execute(
                    f"""
                    select count(distinct tq.query) as total
                    from trend_queries tq
                    join source_files sf on sf.id = tq.source_file_id
                    {clause}
                    """,
                    values,
                ).fetchone()["total"]
                rows = conn.execute(
                    f"""
                    with filtered as (
                      select
                        tq.id,
                        tq.query,
                        sf.path as source_path,
                        tq.source_row
                      from trend_queries tq
                      join source_files sf on sf.id = tq.source_file_id
                      {clause}
                    ),
                    first_rows as (
                      select min(id) as id
                      from filtered
                      group by query
                    )
                    select
                      tq.id,
                      tq.geo,
                      tq.category,
                      tq.date_range,
                      tq.query,
                      tq.translation_original,
                      tq.translation_ai,
                      tq.change_label,
                      tq.change_value,
                      tq.change_is_breakout,
                      sf.name as source_file,
                      {self.collected_date_sql("sf")} as collected_date
                    from first_rows fr
                    join trend_queries tq on tq.id = fr.id
                    join source_files sf on sf.id = tq.source_file_id
                    order by sf.path asc, tq.source_row asc
                    limit {mark} offset {mark}
                    """,
                    [*values, limit, offset],
                ).fetchall()
            else:
                total = conn.execute(
                    f"""
                    select count(*) as total
                    from trend_queries tq
                    join source_files sf on sf.id = tq.source_file_id
                    {clause}
                    """,
                    values,
                ).fetchone()["total"]
                rows = conn.execute(
                    f"""
                    select
                      tq.id,
                      tq.geo,
                      tq.category,
                      tq.date_range,
                      tq.query,
                      tq.translation_original,
                      tq.translation_ai,
                      tq.change_label,
                      tq.change_value,
                      tq.change_is_breakout,
                      sf.name as source_file,
                      {self.collected_date_sql("sf")} as collected_date
                    from trend_queries tq
                    join source_files sf on sf.id = tq.source_file_id
                    {clause}
                    order by sf.path asc, tq.source_row asc
                    limit {mark} offset {mark}
                    """,
                    [*values, limit, offset],
                ).fetchall()
            self.send_json({"total": total, "limit": limit, "offset": offset, "rows": rows})


def prepare_database(database_url, db_path, seed_path):
    """Ensure the schema exists; seed an empty Postgres database from the packaged SQLite file."""
    with connect(db_path if not database_url else None, database_url) as conn:
        ensure_schema(conn, database_url)
        if not database_url:
            return
        row = conn.execute("select count(*) as rows from trend_queries").fetchone()
        count = row["rows"] if isinstance(row, dict) else row[0]
        if count:
            print(f"postgres ready rows={count}")
            return
        seed_path = Path(seed_path)
        if not seed_path.exists():
            print(f"postgres empty and no seed file at {seed_path}")
            return
        from seed_postgres_from_sqlite import seed_from_sqlite

        counts = seed_from_sqlite(conn, seed_path, database_url)
        print(f"seeded postgres from {seed_path}: {counts}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument("--seed-sqlite", default=os.environ.get("SEED_SQLITE", str(DEFAULT_DB)))
    parser.add_argument("--web", default=str(DEFAULT_WEB))
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()

    TrendsHandler.db_path = Path(args.db)
    TrendsHandler.database_url = args.database_url
    TrendsHandler.web_root = Path(args.web)
    TrendsHandler.ingest_token = os.environ.get("INGEST_TOKEN", "").strip()

    attempts = 20 if TrendsHandler.database_url else 1
    for attempt in range(1, attempts + 1):
        try:
            prepare_database(TrendsHandler.database_url, TrendsHandler.db_path, args.seed_sqlite)
            break
        except Exception as error:
            if attempt >= attempts:
                print(f"warning: database preparation failed: {type(error).__name__}: {error}")
                break
            print(f"database not ready (attempt {attempt}/{attempts}): {error}")
            time.sleep(3)

    server = ThreadingHTTPServer((args.host, args.port), TrendsHandler)
    print(f"serving http://{args.host}:{args.port}")
    if TrendsHandler.database_url:
        print("db=DATABASE_URL")
    else:
        print(f"db={TrendsHandler.db_path.resolve()}")
    print(f"ingest={'enabled' if TrendsHandler.ingest_token else 'disabled'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
