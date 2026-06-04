const state = {
  offset: 0,
  limit: 80,
  total: 0,
};

const el = (id) => document.getElementById(id);
const filters = ["search", "geo", "category", "translated", "change"];

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function params() {
  const query = new URLSearchParams();
  for (const id of filters) {
    const value = el(id).value.trim();
    if (value) query.set(id, value);
  }
  query.set("limit", state.limit);
  query.set("offset", state.offset);
  return query;
}

function metric(label, value, tone) {
  return `<article class="metric-card" style="border-top:4px solid ${tone}">
    <span>${label}</span>
    <strong>${escapeHtml(value)}</strong>
  </article>`;
}

async function loadSummary() {
  const summary = await getJson("/api/summary");
  el("metrics").innerHTML = [
    metric("总记录", formatNumber(summary.rows), "#6c8cff"),
    metric("唯一查询", formatNumber(summary.unique_queries), "#34d3c7"),
    metric("国家", formatNumber(summary.geos), "#ffd166"),
    metric("分类", formatNumber(summary.categories), "#ff7aa8"),
    metric("飙升", formatNumber(summary.breakouts), "#82d173"),
    metric("AI 翻译率", `${summary.translated_rate}%`, "#9b7cff"),
  ].join("");
}

async function loadFacets() {
  const facets = await getJson("/api/facets");
  fillSelect("geo", "全部国家", facets.geos);
  fillSelect("category", "全部分类", facets.categories);
}

function fillSelect(id, label, rows) {
  const select = el(id);
  const current = select.value;
  select.innerHTML = `<option value="">${label}</option>` + rows
    .map((row) => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.value)} (${row.count})</option>`)
    .join("");
  select.value = current;
}

function renderBars(containerId, rows) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  el(containerId).innerHTML = rows.map((row) => {
    const width = Math.max(3, Math.round(row.value / max * 100));
    return `<div class="bar-row">
      <strong title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</strong>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      <span>${formatNumber(row.value)}</span>
    </div>`;
  }).join("");
}

async function loadCharts() {
  const chart = await getJson("/api/chart");
  renderBars("geoChart", chart.by_geo);
  renderBars("categoryChart", chart.by_category);
}

function renderRows(rows) {
  if (!rows.length) {
    el("rows").innerHTML = `<tr><td colspan="7"><div class="empty">没有匹配记录</div></td></tr>`;
    return;
  }
  el("rows").innerHTML = rows.map((row) => `
    <tr>
      <td class="query">${escapeHtml(row.query)}</td>
      <td class="translation">${escapeHtml(row.translation_ai || "")}</td>
      <td class="translation">${escapeHtml(row.translation_original || "")}</td>
      <td>${escapeHtml(row.geo)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.change_label)}</td>
      <td>${escapeHtml(row.source_file)}</td>
    </tr>
  `).join("");
}

async function loadRows() {
  el("status").textContent = "读取中...";
  const data = await getJson(`/api/trends?${params().toString()}`);
  state.total = data.total;
  renderRows(data.rows);
  const start = data.total ? data.offset + 1 : 0;
  const end = Math.min(data.offset + data.limit, data.total);
  el("resultCount").textContent = `${formatNumber(data.total)} 条记录，当前 ${start}-${end}`;
  const page = Math.floor(data.offset / data.limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  el("pageInfo").textContent = `${page} / ${pages}`;
  el("prev").disabled = data.offset <= 0;
  el("next").disabled = data.offset + data.limit >= data.total;
  el("status").textContent = "已同步数据";
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function refresh(resetOffset = true) {
  if (resetOffset) state.offset = 0;
  await Promise.all([loadSummary(), loadCharts(), loadRows()]);
}

function bindEvents() {
  const debouncedRefresh = debounce(() => refresh(true), 250);
  for (const id of filters) {
    const eventName = id === "search" ? "input" : "change";
    el(id).addEventListener(eventName, debouncedRefresh);
  }
  el("reset").addEventListener("click", () => {
    for (const id of filters) el(id).value = "";
    refresh(true);
  });
  el("prev").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadRows();
  });
  el("next").addEventListener("click", () => {
    if (state.offset + state.limit < state.total) {
      state.offset += state.limit;
      loadRows();
    }
  });
}

async function boot() {
  try {
    bindEvents();
    await loadFacets();
    await refresh(true);
  } catch (error) {
    el("status").textContent = `加载失败: ${error.message || error}`;
  }
}

boot();
