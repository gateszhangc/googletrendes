import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const token = "test-ingest-token";

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
  assert(topRows.total === 3, `expected 3 top rows, got ${topRows.total}`);
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
  assert(summary.rows === 5, `expected 5 rows in summary, got ${summary.rows}`);

  console.log("ingest api tests passed");
} catch (error) {
  console.error(dashboard.logs.join(""));
  throw error;
} finally {
  dashboard.child.kill("SIGTERM");
  stub.server.close();
  await rm(workDir, { recursive: true, force: true });
}
