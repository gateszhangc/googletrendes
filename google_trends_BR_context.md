# Google Trends BR Capture Context

## Goal

Capture Brazil Google Trends Explore data across the 25 top-level categories.

## Target Data Surface

Use Google Trends Explore only:

```text
https://trends.google.com/trends/explore?cat={category_id}&date=now%207-d&geo=BR&hl=pt-BR
```

Required module:

```text
Consultas de pesquisa / Em ascensão
```

This means rising related search queries from the Explore page.

## Scope Rules

- Do not switch to `https://trends.google.com/trending`.
- Do not use Trending Now as a substitute.
- Keep `gprop` default, which means Google Web Search.
- Keep country as Brazil: `geo=BR`.
- Keep timeframe as last 7 days: `date=now 7-d`.
- Category traversal is over the 25 top-level categories configured in `scripts/capture_google_trends_br_rising.sh`.
- Do not modify Hermes skill files.
- Browser automation should use local Chrome and stop immediately on 429/page error.

## Output Files

- Capture status: `google_trends_BR_rising_status.json`
- Capture data: `google_trends_BR_rising_by_category_*.tsv`
- Capture log: `google_trends_BR_rising_by_category_*.log`
- Analysis report: `google_trends_BR_rising_by_category_*_analysis.md`

## Current Operational Strategy

- A launchd watcher runs every 30 minutes.
- It reads `google_trends_BR_rising_status.json`.
- If cooldown has not elapsed, it does nothing.
- If cooldown has elapsed, it starts the conservative capture script.
- Capture writes rows category by category.
- If Google returns 429, page error, or no Explore widget, capture stops and writes the next retry time into status JSON.
- If capture completes, the watcher calls Codex CLI to analyze the TSV and log.

## Analysis Requirements

When analysis runs:

- Analyze only local TSV/log/status/context files.
- Do not browse the web.
- Output Chinese Markdown.
- Report coverage, row counts, strongest growth terms, repeated terms across categories, category-level findings, data quality issues, and next collection recommendations.
