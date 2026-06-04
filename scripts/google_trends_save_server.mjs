import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.GT_SAVE_PORT || 18765);
const outputRoot = path.resolve(process.env.GT_SAVE_ROOT || process.cwd());

function today() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeFilename(value) {
  const basename = path.basename(String(value || "google_trends_rising.tsv"));
  return basename.replace(/[^\w.\-]+/g, "_") || "google_trends_rising.tsv";
}

async function writeUniqueFile(dir, filename, content) {
  const extension = path.extname(filename);
  const basename = extension ? filename.slice(0, -extension.length) : filename;

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `_${String(index).padStart(2, "0")}`;
    const candidate = path.join(dir, `${basename}${suffix}${extension}`);
    let handle;
    try {
      handle = await fs.open(candidate, "wx");
      await handle.writeFile(content, "utf8");
      return candidate;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      if (error.code === "EEXIST") continue;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  throw new Error(`too many existing files for ${filename}`);
}

function send(res, statusCode, payload, origin = "https://trends.google.com") {
  res.writeHead(statusCode, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  res.end(html);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(req, body) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    return {
      filename: params.get("filename"),
      content: params.get("content"),
    };
  }
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "https://trends.google.com";

  if (req.method === "GET" && req.url === "/receiver") {
    sendHtml(res, `<!doctype html>
<meta charset="utf-8">
<title>Google Trends Local Saver</title>
<body style="font:13px Arial,sans-serif;padding:16px;color:#202124">
<h3 style="margin:0 0 8px">Google Trends Local Saver</h3>
<pre id="status" style="white-space:pre-wrap">waiting for data...</pre>
<script>
const statusEl = document.getElementById("status");

async function saveData(data) {
  if (data.type !== "gt-save") return;
  try {
    statusEl.textContent = "saving " + data.filename + "...";
    const response = await fetch("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: data.filename, content: data.content })
    });
    const result = await response.json();
    statusEl.textContent = result.ok ? "saved:\\n" + result.path : "failed:\\n" + result.error;
    if (window.opener) window.opener.postMessage({ type: "gt-save-result", ...result }, "*");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = "failed:\\n" + message;
    if (window.opener) window.opener.postMessage({ type: "gt-save-result", ok: false, error: message }, "*");
  }
}

try {
  if (window.name) {
    const payload = JSON.parse(window.name);
    window.name = "";
    saveData(payload);
  }
} catch (error) {
  statusEl.textContent = "failed to read window.name:\\n" + (error && error.message ? error.message : String(error));
}

window.addEventListener("message", async (event) => {
  const data = event.data || {};
  saveData(data);
});
</script>`);
    return;
  }

  if (req.method === "OPTIONS") {
    send(res, 204, {}, origin);
    return;
  }

  if (req.method !== "POST" || req.url !== "/save") {
    send(res, 404, { ok: false, error: "not found" }, origin);
    return;
  }

  try {
    const input = parseInput(req, await readBody(req));
    const content = String(input.content || "");
    if (!content) {
      send(res, 400, { ok: false, error: "empty content" }, origin);
      return;
    }

    const dateDir = today();
    const dir = path.join(outputRoot, dateDir);
    const filename = safeFilename(input.filename);

    await fs.mkdir(dir, { recursive: true });
    const filePath = await writeUniqueFile(dir, filename, content);

    send(res, 200, { ok: true, path: filePath }, origin);
  } catch (error) {
    send(res, 500, { ok: false, error: error.message || String(error) }, origin);
  }
});

server.listen(port, host, () => {
  console.log(`google_trends_save_server listening on http://${host}:${port}`);
  console.log(`output root: ${outputRoot}`);
});
