#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import connect, driver_name, placeholder


DEFAULT_DB = Path("data/google_trends.sqlite")
DEFAULT_WEB = Path("web")


class TrendsHandler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB
    database_url = ""
    web_root = DEFAULT_WEB

    def log_message(self, format, *args):
        return

    def db(self):
        return connect(self.db_path, self.database_url)

    def collected_date_sql(self, alias="sf"):
        if self.database_url:
            return f"substring({alias}.name from 22 for 10)"
        return f"substr({alias}.name, 22, 10)"

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
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
            self.send_json({
                "geos": geos,
                "categories": categories,
                "dates": dates,
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument("--web", default=str(DEFAULT_WEB))
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()

    TrendsHandler.db_path = Path(args.db)
    TrendsHandler.database_url = args.database_url
    TrendsHandler.web_root = Path(args.web)
    server = ThreadingHTTPServer((args.host, args.port), TrendsHandler)
    print(f"serving http://{args.host}:{args.port}")
    if TrendsHandler.database_url:
        print("db=DATABASE_URL")
    else:
        print(f"db={TrendsHandler.db_path.resolve()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
