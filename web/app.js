const state = {
  offset: 0,
  limit: 80,
  total: 0,
  latestCollectedDate: "",
  loadingRows: false,
  loadedUntil: 0,
};

const el = (id) => document.getElementById(id);
const filters = ["collectedDate", "search", "geo", "category", "queryMode", "translated", "change"];

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
    if (!value) continue;
    if (id === "collectedDate") {
      query.set("collected_date", value);
    } else if (id === "queryMode" && value === "unique") {
      query.set("unique", "yes");
    } else if (id !== "queryMode") {
      query.set(id, value);
    }
  }
  query.set("limit", state.limit);
  query.set("offset", state.offset);
  return query;
}

function totalPages() {
  return Math.max(1, Math.ceil(state.total / state.limit));
}

function metric(label, value, tone) {
  return `<article class="metric-card" style="border-top:4px solid ${tone}">
    <span>${label}</span>
    <strong>${escapeHtml(value)}</strong>
  </article>`;
}

async function loadSummary() {
  const query = new URLSearchParams();
  if (el("collectedDate").value) query.set("collected_date", el("collectedDate").value);
  const summary = await getJson(`/api/summary?${query.toString()}`);
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
  state.latestCollectedDate = facets.latest_collected_date || "";
  fillSelect("collectedDate", "全部日期", facets.collected_dates);
  if (state.latestCollectedDate && !el("collectedDate").value) {
    el("collectedDate").value = state.latestCollectedDate;
  }
  fillSelect("geo", "全部国家", facets.geos);
  fillSelect("category", "全部分类", facets.categories);
  renderBatchLabel();
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
  const query = new URLSearchParams();
  if (el("collectedDate").value) query.set("collected_date", el("collectedDate").value);
  const chart = await getJson(`/api/chart?${query.toString()}`);
  renderBars("geoChart", chart.by_geo);
  renderBars("categoryChart", chart.by_category);
}

function renderRows(rows, append = false) {
  if (!rows.length) {
    if (!append) {
      el("rows").innerHTML = `<tr><td colspan="8"><div class="empty">没有匹配记录</div></td></tr>`;
    }
    return;
  }
  const html = rows.map((row) => `
    <tr>
      <td class="query">${escapeHtml(row.query)}</td>
      <td class="translation">${escapeHtml(row.translation_ai || "")}</td>
      <td class="translation">${escapeHtml(row.translation_original || "")}</td>
      <td>${escapeHtml(row.geo)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.change_label)}</td>
      <td>${escapeHtml(row.collected_date || "")}</td>
      <td>${escapeHtml(row.source_file)}</td>
    </tr>
  `).join("");
  if (append) {
    el("rows").insertAdjacentHTML("beforeend", html);
  } else {
    el("rows").innerHTML = html;
  }
}

async function loadRows({ append = false } = {}) {
  if (state.loadingRows) return;
  state.loadingRows = true;
  el("status").textContent = "读取中...";
  try {
    const data = await getJson(`/api/trends?${params().toString()}`);
    state.total = data.total;
    renderRows(data.rows, append);
    state.loadedUntil = append
      ? Math.min(state.loadedUntil + data.rows.length, data.total)
      : Math.min(data.offset + data.rows.length, data.total);
    const start = data.total ? (append ? 1 : data.offset + 1) : 0;
    const end = state.loadedUntil;
    const rangeLabel = append ? "已加载" : "当前";
    el("resultCount").textContent = `${formatNumber(data.total)} 条记录，${rangeLabel} ${start}-${end}`;
    const loadedPages = Math.max(1, Math.ceil(state.loadedUntil / state.limit));
    const pages = totalPages();
    el("pageJump").value = loadedPages;
    el("pageJump").max = pages;
    el("pageTotal").textContent = `/ ${pages}`;
    el("prev").disabled = state.offset <= 0;
    el("next").disabled = state.loadedUntil >= data.total;
    el("jumpPage").disabled = data.total <= state.limit;
    el("status").textContent = "已同步数据";
    renderBatchLabel();
  } finally {
    state.loadingRows = false;
  }
}

function renderBatchLabel() {
  const value = el("collectedDate").value;
  el("batchLabel").textContent = value ? `${value} 抓取批次` : "全部抓取批次";
}

function scrollToTableTop() {
  const panel = document.querySelector(".table-panel");
  if (!panel) return;
  window.scrollTo({
    top: panel.getBoundingClientRect().top + window.scrollY,
    behavior: "auto",
  });
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function refresh(resetOffset = true) {
  if (resetOffset) {
    state.offset = 0;
    state.loadedUntil = 0;
    el("rows").innerHTML = "";
    const tableWrap = document.querySelector(".table-wrap");
    if (tableWrap) tableWrap.scrollTop = 0;
  }
  await Promise.all([loadSummary(), loadCharts(), loadRows()]);
}

async function loadNextPage() {
  if (state.loadingRows || state.loadedUntil >= state.total) return;
  state.offset = state.loadedUntil;
  await loadRows({ append: true });
}

async function jumpToPage() {
  const pages = totalPages();
  const requested = Number.parseInt(el("pageJump").value, 10);
  const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), pages);
  state.offset = (page - 1) * state.limit;
  state.loadedUntil = 0;
  el("rows").innerHTML = "";
  const tableWrap = document.querySelector(".table-wrap");
  if (tableWrap) tableWrap.scrollTop = 0;
  await loadRows();
  scrollToTableTop();
}

function maybeLoadNextFromTableScroll() {
  const wrap = document.querySelector(".table-wrap");
  if (!wrap) return;
  const maxScroll = wrap.scrollHeight - wrap.clientHeight;
  if (maxScroll <= 0) return;
  const scrollProgress = wrap.scrollTop / maxScroll;
  if (scrollProgress >= 0.8) loadNextPage();
}

function bindEvents() {
  const debouncedRefresh = debounce(() => refresh(true), 250);
  for (const id of filters) {
    const eventName = id === "search" ? "input" : "change";
    el(id).addEventListener(eventName, debouncedRefresh);
  }
  el("reset").addEventListener("click", () => {
    for (const id of filters) el(id).value = "";
    if (state.latestCollectedDate) el("collectedDate").value = state.latestCollectedDate;
    refresh(true);
  });
  el("prev").addEventListener("click", async () => {
    state.offset = Math.max(0, state.offset - state.limit);
    state.loadedUntil = 0;
    await loadRows();
    document.querySelector(".table-wrap").scrollTop = 0;
  });
  el("next").addEventListener("click", async () => {
    await loadNextPage();
  });
  el("jumpPage").addEventListener("click", jumpToPage);
  el("pageJump").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPage();
    }
  });
  document.querySelector(".table-wrap").addEventListener("scroll", maybeLoadNextFromTableScroll);
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
