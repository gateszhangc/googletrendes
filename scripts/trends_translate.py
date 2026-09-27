#!/usr/bin/env python3
"""Shared Google Trends query translation helpers.

The module supports two Anthropic/OpenAI compatible providers:

* DeepSeek (``DEEPSEEK_API_KEY``, ``DEEPSEEK_BASE_URL``, ``DEEPSEEK_MODEL``)
* Anthropic style (``ANTHROPIC_AUTH_TOKEN``/``ANTHROPIC_API_KEY``, ``ANTHROPIC_BASE_URL``,
  ``ANTHROPIC_DEFAULT_HAIKU_MODEL``/``ANTHROPIC_MODEL``)

Translations are cached in the ``translation_cache`` table so the dashboard and the
ingest endpoint never pay for the same query twice.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trends_db import placeholder


DEFAULT_BATCH_SIZE = 60


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def extract_json_array(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        raise ValueError(f"model did not return a JSON array: {text[:300]}")
    return json.loads(text[start : end + 1])


def build_prompt(items):
    numbered = [{"id": index, "query": query} for index, query in items]
    return (
        "你是 Google Trends 搜索词翻译器。把每个 query 翻译成简体中文。\n"
        "要求：保留品牌名、人名、队名、网址、型号、专有名词的可识别性；不要解释；"
        "如果原文已经是中文，直接返回原文；如果是乱码或无法可靠翻译，返回空字符串。\n"
        '只返回 JSON 数组，格式为：[{"id":1,"translation":"..."}]。\n'
        f"输入：{json.dumps(numbered, ensure_ascii=False)}"
    )


def provider_config():
    """Return the active provider config, or None when no credentials are configured."""
    deepseek_token = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if deepseek_token:
        return {
            "kind": "openai",
            "name": "deepseek",
            "token": deepseek_token,
            "base_url": (os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/"),
            "model": (os.environ.get("DEEPSEEK_MODEL") or "deepseek-flash").strip(),
        }

    token = (os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if token:
        return {
            "kind": "anthropic",
            "name": "anthropic",
            "token": token,
            "base_url": (os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/"),
            "model": (
                os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
                or os.environ.get("ANTHROPIC_MODEL")
                or "claude-3-5-haiku-latest"
            ).strip(),
        }

    return None


def _openai_batch(items, config, timeout=90):
    payload = {
        "model": config["model"],
        "temperature": 0,
        "max_tokens": 8192,
        "messages": [{"role": "user", "content": build_prompt(items)}],
    }
    request = urllib.request.Request(
        f"{config['base_url']}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {config['token']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    choices = data.get("choices") or []
    text = (choices[0].get("message", {}).get("content") if choices else "") or ""
    return extract_json_array(text)


def _anthropic_batch(items, config, timeout=90):
    payload = {
        "model": config["model"],
        "max_tokens": 8192,
        "temperature": 0,
        "messages": [{"role": "user", "content": build_prompt(items)}],
    }
    request = urllib.request.Request(
        f"{config['base_url']}/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": config["token"],
            "authorization": f"Bearer {config['token']}",
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    content = data.get("content") or []
    text = "\n".join(
        block.get("text", "") for block in content if block.get("type") == "text"
    ).strip()
    return extract_json_array(text)


def translate_batch(items, config):
    """Translate a batch of (id, query) pairs, splitting on provider failures."""
    try:
        if config["kind"] == "openai":
            results = _openai_batch(items, config)
        else:
            results = _anthropic_batch(items, config)
    except Exception:
        if len(items) <= 1:
            raise
        midpoint = len(items) // 2
        left = translate_batch(items[:midpoint], config)
        right = translate_batch(items[midpoint:], config)
        return {**left, **right}

    by_id = {}
    for item in results:
        if isinstance(item, dict) and "id" in item:
            try:
                index = int(item["id"])
            except (TypeError, ValueError):
                continue
            by_id[index] = str(item.get("translation") or "").strip()
    return by_id


def translate_queries(queries, config=None, batch_size=DEFAULT_BATCH_SIZE):
    """Return {query: translation} for the given queries (empty values dropped)."""
    config = config or provider_config()
    if not config:
        return {}

    mapping = {}
    for offset in range(0, len(queries), batch_size):
        batch = list(queries[offset : offset + batch_size])
        items = list(enumerate(batch, start=1))
        try:
            results = translate_batch(items, config)
        except Exception:
            continue
        for index, query in items:
            translation = (results.get(index) or "").strip()
            if translation:
                mapping[query] = translation
    return mapping


def save_translations(conn, database_url, mapping, model):
    mark = placeholder(database_url)
    saved = 0
    for query, translation in mapping.items():
        if not translation:
            continue
        conn.execute(
            f"""
            insert into translation_cache(query, translation_ai, model, updated_at)
            values ({mark}, {mark}, {mark}, {mark})
            on conflict(query) do update set
              translation_ai=excluded.translation_ai,
              model=excluded.model,
              updated_at=excluded.updated_at
            """,
            (query, translation, model, utc_now()),
        )
        saved += 1
    return saved


def apply_cache_to_rows(conn, database_url, source_file_id=None):
    mark = placeholder(database_url)
    clause = ""
    values = ()
    if source_file_id is not None:
        clause = f"where source_file_id = {mark}"
        values = (source_file_id,)
    conn.execute(
        f"""
        update trend_queries
        set translation_ai = coalesce((
          select translation_ai from translation_cache
          where translation_cache.query = trend_queries.query
        ), translation_ai)
        {clause}
        """,
        values,
    )


def pending_queries(conn, database_url="", limit=0):
    mark = placeholder(database_url)
    sql = """
      select distinct tq.query
      from trend_queries tq
      left join translation_cache tc on tc.query = tq.query
      where coalesce(tc.translation_ai, '') = ''
      order by tq.query
    """
    values = ()
    if limit:
        sql += f" limit {mark}"
        values = (limit,)
    rows = conn.execute(sql, values).fetchall()
    return [row["query"] if isinstance(row, dict) else row[0] for row in rows]


def translate_source_file(conn, database_url, source_file_id, config=None):
    """Translate the pending queries of one uploaded file; returns (translated, pending)."""
    mark = placeholder(database_url)
    rows = conn.execute(
        f"""
        select distinct query from trend_queries
        where source_file_id = {mark} and coalesce(translation_ai, '') = ''
        order by query
        """,
        (source_file_id,),
    ).fetchall()
    queries = [row["query"] if isinstance(row, dict) else row[0] for row in rows]

    config = config or provider_config()
    translated = 0
    if queries and config:
        mapping = translate_queries(queries, config)
        translated = save_translations(conn, database_url, mapping, config["model"])
        apply_cache_to_rows(conn, database_url, source_file_id)

    pending_row = conn.execute(
        f"select count(*) as pending from trend_queries where source_file_id = {mark} and coalesce(translation_ai, '') = ''",
        (source_file_id,),
    ).fetchone()
    pending = pending_row["pending"] if isinstance(pending_row, dict) else pending_row[0]
    return translated, pending


def translate_database(conn, database_url="", limit=0, batch_size=DEFAULT_BATCH_SIZE):
    """Fill missing AI translations for every row that lacks one."""
    config = provider_config()
    if not config:
        raise RuntimeError(
            "no translation credentials configured (set DEEPSEEK_API_KEY or ANTHROPIC_AUTH_TOKEN)"
        )
    queries = pending_queries(conn, database_url, limit)
    mapping = translate_queries(queries, config, batch_size)
    saved = save_translations(conn, database_url, mapping, config["model"])
    apply_cache_to_rows(conn, database_url)
    return len(queries), saved
