import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const token = "test-ingest-token";

// submit_sites 只加在 Postgres schema 里（生产库）；本地 SQLite 测试用同样的 DDL 建表。
const SUBMIT_SITES_DDL = `
create table if not exists submit_sites (
  host text primary key,
  url text not null default '',
  source_report text not null default '',
  as_score integer,
  backlinks integer,
  status_label text not null default '',
  first_seen text not null default '',
  last_seen text not null default '',
  has_submit integer not null default 0,
  check_status text not null default 'pending',
  category text not null default '',
  evidence text not null default '',
  submit_url text not null default '',
  check_error text not null default '',
  checked_at text not null default '',
  first_saved_at text not null default '',
  updated_at text not null default ''
);
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth(baseUrl, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await sleep(250);
  }
  throw new Error("dashboard server did not become healthy");
}

function startTranslationStub() {
  const state = { calls: 0, queries: [] };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end("not found");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const prompt = payload.messages?.[0]?.content || "";
    const input = JSON.parse(prompt.slice(prompt.indexOf("输入：") + 3));
    state.calls += 1;
    state.queries.push(...input.map((item) => item.query));
    const translations = input.map((item) => ({
      id: item.id,
      translation: `译-${item.query}`,
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify(translations) } }],
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

async function startDashboard({ port, dbPath, baseUrl }) {
  const child = spawn(
    "python3",
    [
      "scripts/serve_trends_dashboard.py",
      "--db",
      dbPath,
      "--web",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        INGEST_TOKEN: token,
        DEEPSEEK_API_KEY: "stub-key",
        DEEPSEEK_BASE_URL: baseUrl,
        DEEPSEEK_MODEL: "stub-model",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function postIngest(baseUrl, payload, options = {}) {
  const response = await fetch(`${baseUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.authorized === false ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function postSubmitSites(baseUrl, payload, options = {}) {
  const response = await fetch(`${baseUrl}/api/submit-sites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.authorized === false ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function seedSubmitSitesTable(dbPath) {
  const result = spawn("python3", ["-c", `import sqlite3,sys; conn=sqlite3.connect(sys.argv[1]); conn.executescript(sys.argv[2]); conn.commit()`, dbPath, SUBMIT_SITES_DDL], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    result.on("close", (code) => (code === 0 ? resolve() : reject(new Error("failed to seed submit_sites table"))));
  });
}

const workDir = await mkdtemp(join(tmpdir(), "gt-ingest-"));
const dbPath = join(workDir, "trends.sqlite");
const port = 18700 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const stub = await startTranslationStub();
const dashboard = await startDashboard({
  port,
  dbPath,
  baseUrl: `http://127.0.0.1:${stub.port}`,
});

try {
  await waitForHealth(baseUrl);
  await seedSubmitSitesTable(dbPath);

  const unauthorizedSubmit = await postSubmitSites(
    baseUrl,
    { items: [{ host: "awesome.video" }] },
    { authorized: false }
  );
  assert(unauthorizedSubmit.status === 401, `expected 401 for submit-sites, got ${unauthorizedSubmit.status}`);

  const emptySubmit = await postSubmitSites(baseUrl, { items: [] });
  assert(emptySubmit.status === 400, `expected 400 for empty submit-sites payload, got ${emptySubmit.status}`);

  const firstSubmit = await postSubmitSites(baseUrl, {
    source: "submit-entry-checker",
    report_domain: "byteplus.com",
    items: [
      {
        host: "https://www.Awesome.video/",
        url: "https://awesome.video/",
        as: 19,
        backlinks: 1,
        status: "新增",
        firstSeen: "2026年8月3日",
        lastSeen: "12 天前",
        hasSubmit: true,
        checkStatus: "hit",
        category: "submit_text",
        evidence: "Submit",
        submitUrl: "https://awesome.video/submit",
        checkedAt: "2026-09-29T06:35:00Z",
      },
      { host: "example.com", checkStatus: "miss", hasSubmit: false },
      { host: "not a host", checkStatus: "miss" },
    ],
  });
  assert(firstSubmit.status === 200, `expected 200 for submit-sites, got ${firstSubmit.status}`);
  assert(firstSubmit.body.inserted === 2, `expected 2 inserted sites, got ${firstSubmit.body.inserted}`);
  assert(firstSubmit.body.skipped === 1, `expected 1 skipped site, got ${firstSubmit.body.skipped}`);

  const hitSites = await (await fetch(`${baseUrl}/api/submit-sites?has_submit=1`)).json();
  assert(hitSites.total === 1, `expected 1 submit hit, got ${hitSites.total}`);
  assert(hitSites.items[0].host === "awesome.video", `unexpected hit host: ${hitSites.items[0].host}`);
  assert(hitSites.items[0].has_submit === 1, "expected has_submit=1 on the hit");
  assert(
    hitSites.items[0].submit_url === "https://awesome.video/submit",
    `unexpected submit url: ${hitSites.items[0].submit_url}`
  );
  assert(hitSites.items[0].as_score === 19, `unexpected as_score: ${hitSites.items[0].as_score}`);
  assert(
    hitSites.items[0].source_report === "byteplus.com",
    `expected report_domain fallback on the hit, got ${hitSites.items[0].source_report}`
  );

  const secondSubmit = await postSubmitSites(baseUrl, {
    report_domain: "byteplus.com",
    items: [
      {
        host: "awesome.video",
        checkStatus: "miss",
        hasSubmit: false,
        evidence: "no longer",
        sourceReport: "explicit.example",
      },
    ],
  });
  assert(secondSubmit.body.updated === 1, `expected 1 updated site, got ${secondSubmit.body.updated}`);
  assert(secondSubmit.body.inserted === 0, "expected no inserts on the second upload");

  const allSites = await (await fetch(`${baseUrl}/api/submit-sites`)).json();
  assert(allSites.total === 2, `expected 2 sites, got ${allSites.total}`);
  const updatedSite = allSites.items.find((item) => item.host === "awesome.video");
  assert(updatedSite.has_submit === 0, "expected has_submit to be cleared by the second upload");
  assert(updatedSite.evidence === "no longer", `unexpected evidence: ${updatedSite.evidence}`);
  assert(
    allSites.items[0].has_submit === 0,
    "expected sites to be ordered by has_submit desc then updated_at"
  );
  assert(
    updatedSite.source_report === "explicit.example",
    `expected per-item sourceReport to win, got ${updatedSite.source_report}`
  );

  // 逐条没带 sourceReport 时，用请求里的 report_domain 兜底。
  const fallbackSubmit = await postSubmitSites(baseUrl, {
    report_domain: "fallback.example",
    items: [{ host: "fallback-site.com", checkStatus: "miss", hasSubmit: false }],
  });
  assert(fallbackSubmit.body.inserted === 1, `expected 1 inserted site, got ${fallbackSubmit.body.inserted}`);
  const fallbackSites = await (await fetch(`${baseUrl}/api/submit-sites?q=fallback-site`)).json();
  assert(
    fallbackSites.items[0].source_report === "fallback.example",
    `expected report_domain fallback, got ${fallbackSites.items[0].source_report}`
  );

  const searched = await (await fetch(`${baseUrl}/api/submit-sites?q=awesome`)).json();
  assert(searched.total === 1, `expected 1 search result, got ${searched.total}`);
  assert(searched.items[0].host === "awesome.video", "unexpected search result host");

  const unauthorized = await postIngest(
    baseUrl,
    { batch: { type: "top", geo: "US", category: "餐饮" }, rows: [{ query: "amazon" }] },
    { authorized: false }
  );
  assert(unauthorized.status === 401, `expected 401 without token, got ${unauthorized.status}`);

  const invalid = await postIngest(baseUrl, {
    batch: { type: "sideways", geo: "US", category: "餐饮" },
    rows: [{ query: "amazon" }],
  });
  assert(invalid.status === 400, `expected 400 for invalid type, got ${invalid.status}`);

  const batch = {
    batch: {
      type: "top",
      geo: "US",
      category: "餐饮",
      date_range: "now 7-d",
      collected_date: "2026-09-27",
      term: "south",
    },
    rows: [
      { rank: 1, query: "amazon", change: "-4%" },
      { rank: 2, query: "walmart", change: "-6%" },
      { rank: 3, query: "rays vs yankees", change: "暴增" },
    ],
  };

  const first = await postIngest(baseUrl, batch);
  assert(first.status === 200, `expected 200, got ${first.status}: ${JSON.stringify(first.body)}`);
  assert(first.body.ok === true, "expected ok=true");
  assert(first.body.inserted === 3, `expected 3 inserted rows, got ${first.body.inserted}`);
  assert(first.body.translated === 3, `expected 3 translations, got ${first.body.translated}`);
  assert(first.body.pending_translation === 0, "expected no pending translations");
  assert(
    first.body.source_file === "google_trends_top_2026-09-27_south.tsv",
    `unexpected source file: ${first.body.source_file}`
  );

  const duplicate = await postIngest(baseUrl, batch);
  assert(duplicate.body.deduped === true, "expected duplicate upload to be deduped");
  assert(duplicate.body.inserted === 0, "expected deduped upload to insert nothing");
  assert(stub.state.calls === 1, `expected a single translation call, got ${stub.state.calls}`);

  const otherTerm = await postIngest(baseUrl, {
    ...batch,
    batch: { ...batch.batch, term: "north" },
  });
  assert(otherTerm.body.deduped === false, "expected a different seed term to create a new file");
  assert(
    otherTerm.body.source_file === "google_trends_top_2026-09-27_north.tsv",
    `unexpected second source file: ${otherTerm.body.source_file}`
  );

  const rising = await postIngest(baseUrl, {
    ...batch,
    batch: { ...batch.batch, type: "rising", term: "" },
    rows: batch.rows.slice(0, 2),
  });
  assert(rising.status === 200, `expected 200 for rising batch, got ${rising.status}`);
  assert(
    rising.body.source_file === "google_trends_rising_2026-09-27.tsv",
    `unexpected rising source file: ${rising.body.source_file}`
  );
  assert(rising.body.translated === 0, "expected cached translations to be reused");

  const topRows = await (await fetch(`${baseUrl}/api/trends?type=top&limit=10`)).json();
  assert(topRows.total === 6, `expected 6 top rows, got ${topRows.total}`);
  assert(
    topRows.rows.every((row) => row.translation_ai.startsWith("译-")),
    "expected AI translations on ingested rows"
  );
  assert(
    topRows.rows.every((row) => row.translation_original === ""),
    "expected page translations to stay empty"
  );
  assert(
    topRows.rows.every((row) => row.collected_date === "2026-09-27"),
    "expected stored collected_date on ingested rows"
  );
  const breakout = topRows.rows.find((row) => row.query === "rays vs yankees");
  assert(breakout.change_is_breakout === 1, "expected breakout flag for 暴增");
  assert(breakout.change_value === null, "expected null change value for breakout");
  const amazon = topRows.rows.find((row) => row.query === "amazon");
  assert(amazon.change_value === -4, `expected -4 change value, got ${amazon.change_value}`);

  const risingRows = await (await fetch(`${baseUrl}/api/trends?type=rising&limit=10`)).json();
  assert(risingRows.total === 2, `expected 2 rising rows, got ${risingRows.total}`);

  const facets = await (await fetch(`${baseUrl}/api/facets`)).json();
  const typeValues = facets.types.map((entry) => entry.value).sort();
  assert(
    JSON.stringify(typeValues) === JSON.stringify(["rising", "top"]),
    `expected top+rising facets, got ${JSON.stringify(facets.types)}`
  );
  assert(
    facets.latest_collected_date === "2026-09-27",
    `unexpected latest collected date: ${facets.latest_collected_date}`
  );

  const summary = await (await fetch(`${baseUrl}/api/summary`)).json();
  assert(summary.rows === 8, `expected 8 rows in summary, got ${summary.rows}`);

  // 国家 / 分类排序：再入一批 BR + 体育，验证排序参数作用在整个结果集上。
  const brBatch = await postIngest(baseUrl, {
    batch: {
      type: "top",
      geo: "BR",
      category: "体育",
      date_range: "now 7-d",
      collected_date: "2026-09-27",
      term: "brasil",
    },
    rows: [
      { rank: 1, query: "flamengo", change: "暴增" },
      { rank: 2, query: "palmeiras", change: "+50%" },
    ],
  });
  assert(brBatch.status === 200, `expected 200 for BR batch, got ${brBatch.status}`);

  const geoAsc = await (await fetch(`${baseUrl}/api/trends?sort=geo&order=asc&limit=20`)).json();
  assert(geoAsc.total === 10, `expected 10 rows after BR ingest, got ${geoAsc.total}`);
  assert(geoAsc.rows[0].geo === "BR", `expected BR first on geo asc, got ${geoAsc.rows[0].geo}`);
  assert(
    geoAsc.rows.every((row, index) => index === 0 || geoAsc.rows[index - 1].geo <= row.geo),
    "expected geo asc rows to be ordered"
  );
  const geoDesc = await (await fetch(`${baseUrl}/api/trends?sort=geo&order=desc&limit=20`)).json();
  assert(geoDesc.rows[0].geo === "US", `expected US first on geo desc, got ${geoDesc.rows[0].geo}`);
  assert(
    geoDesc.rows.every((row, index) => index === 0 || geoDesc.rows[index - 1].geo >= row.geo),
    "expected geo desc rows to be ordered"
  );

  const categoryAsc = await (await fetch(`${baseUrl}/api/trends?sort=category&order=asc&limit=20`)).json();
  const categoryDesc = await (await fetch(`${baseUrl}/api/trends?sort=category&order=desc&limit=20`)).json();
  assert(categoryAsc.rows[0].category === "体育", `expected 体育 first on category asc, got ${categoryAsc.rows[0].category}`);
  assert(categoryDesc.rows[0].category === "餐饮", `expected 餐饮 first on category desc, got ${categoryDesc.rows[0].category}`);
  assert(
    categoryAsc.rows.every((row, index) => index === 0 || categoryAsc.rows[index - 1].category <= row.category),
    "expected category asc rows to be ordered"
  );
  assert(
    categoryDesc.rows.every((row, index) => index === 0 || categoryDesc.rows[index - 1].category >= row.category),
    "expected category desc rows to be ordered"
  );
  assert(
    JSON.stringify(categoryDesc.rows.map((row) => row.query).sort()) ===
      JSON.stringify(categoryAsc.rows.map((row) => row.query).sort()),
    "expected category desc to cover the same rows as category asc"
  );

  const uniqueGeoAsc = await (await fetch(`${baseUrl}/api/trends?unique=yes&sort=geo&order=asc&limit=20`)).json();
  assert(uniqueGeoAsc.rows[0].geo === "BR", `expected BR first on unique geo asc, got ${uniqueGeoAsc.rows[0].geo}`);

  // 未在允许列表里的 sort 值按默认排序处理，不能拼进 SQL。
  const defaultRows = await (await fetch(`${baseUrl}/api/trends?limit=20`)).json();
  const bogusSort = await (await fetch(`${baseUrl}/api/trends?sort=geo%3Bdrop%20table&order=desc&limit=20`)).json();
  assert(
    JSON.stringify(bogusSort.rows.map((row) => row.id)) === JSON.stringify(defaultRows.rows.map((row) => row.id)),
    "expected unknown sort values to fall back to the default order"
  );

  console.log("ingest api tests passed");
} catch (error) {
  console.error(dashboard.logs.join(""));
  throw error;
} finally {
  dashboard.child.kill("SIGTERM");
  stub.server.close();
  await rm(workDir, { recursive: true, force: true });
}
