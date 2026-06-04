#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_DB = Path("data/google_trends.sqlite")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def api_config():
    token = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    if not token:
        raise RuntimeError("missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY")
    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    model = (
        os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        or os.environ.get("ANTHROPIC_MODEL")
        or "claude-3-5-haiku-latest"
    )
    return token, base_url, model


def extract_json_array(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        raise ValueError(f"model did not return a JSON array: {text[:300]}")
    return json.loads(text[start : end + 1])


def call_anthropic(items, token, base_url, model):
    numbered = [{"id": index, "query": query} for index, query in items]
    prompt = (
        "你是 Google Trends 搜索词翻译器。把每个 query 翻译成简体中文。\n"
        "要求：保留品牌名、人名、队名、网址、型号、专有名词的可识别性；不要解释；"
        "如果原文已经是中文，直接返回原文；如果是乱码或无法可靠翻译，返回空字符串。\n"
        "只返回 JSON 数组，格式为：[{\"id\":1,\"translation\":\"...\"}]。\n"
        f"输入：{json.dumps(numbered, ensure_ascii=False)}"
    )
    payload = {
        "model": model,
        "max_tokens": 8192,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }
    request = urllib.request.Request(
        f"{base_url}/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": token,
            "authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        data = json.loads(response.read().decode("utf-8"))
    content = data.get("content") or []
    text = "\n".join(
        block.get("text", "") for block in content if block.get("type") == "text"
    ).strip()
    results = extract_json_array(text)
    by_id = {}
    for item in results:
        if isinstance(item, dict) and "id" in item:
            by_id[int(item["id"])] = str(item.get("translation") or "").strip()
    return by_id


def translate_batch(items, token, base_url, model):
    try:
        return call_anthropic(items, token, base_url, model)
    except Exception:
        if len(items) <= 1:
            raise
        midpoint = len(items) // 2
        left = translate_batch(items[:midpoint], token, base_url, model)
        right = translate_batch(items[midpoint:], token, base_url, model)
        return {**left, **right}


def pending_queries(conn, limit):
    sql = """
      select distinct tq.query
      from trend_queries tq
      left join translation_cache tc on tc.query = tq.query
      where coalesce(tc.translation_ai, '') = ''
      order by tq.query
    """
    if limit:
        sql += " limit ?"
        return [row[0] for row in conn.execute(sql, (limit,)).fetchall()]
    return [row[0] for row in conn.execute(sql).fetchall()]


def apply_cache(conn):
    conn.execute(
        """
        update trend_queries
        set translation_ai = coalesce((
          select translation_ai from translation_cache
          where translation_cache.query = trend_queries.query
        ), translation_ai)
        """
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--batch-size", type=int, default=60)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.2)
    args = parser.parse_args()

    token, base_url, model = api_config()
    conn = sqlite3.connect(args.db)
    conn.execute("pragma journal_mode=wal")

    queries = pending_queries(conn, args.limit)
    print(f"pending unique queries={len(queries)} model={model}", flush=True)
    completed = 0
    for offset in range(0, len(queries), args.batch_size):
      batch = queries[offset : offset + args.batch_size]
      items = list(enumerate(batch, start=1))
      for attempt in range(1, 4):
          try:
              translations = translate_batch(items, token, base_url, model)
              break
          except urllib.error.HTTPError as error:
              message = error.read().decode("utf-8", errors="replace")
              if attempt >= 3:
                  raise RuntimeError(f"translation HTTP {error.code}: {message[:500]}") from error
              time.sleep(2 * attempt)
          except Exception:
              if attempt >= 3:
                  raise
              time.sleep(2 * attempt)

      now = utc_now()
      with conn:
          for index, query in items:
              translation = translations.get(index, "")
              conn.execute(
                  """
                  insert into translation_cache(query, translation_ai, model, updated_at)
                  values (?, ?, ?, ?)
                  on conflict(query) do update set
                    translation_ai=excluded.translation_ai,
                    model=excluded.model,
                    updated_at=excluded.updated_at
                  """,
                  (query, translation, model, now),
              )
          apply_cache(conn)
      completed += len(batch)
      print(f"translated {completed}/{len(queries)}", flush=True)
      time.sleep(args.sleep)

    with conn:
        apply_cache(conn)
    translated_rows = conn.execute(
        "select count(*) from trend_queries where coalesce(translation_ai, '') <> ''"
    ).fetchone()[0]
    print(f"translated rows={translated_rows}", flush=True)


if __name__ == "__main__":
    main()
