const state = {
  items: [],
  total: 0,
  offset: 0,
  limit: 200,
};

const elements = {
  rows: document.getElementById("rows"),
  status: document.getElementById("status"),
  search: document.getElementById("search"),
  hasSubmit: document.getElementById("hasSubmitFilter"),
  limit: document.getElementById("limit"),
  pageLabel: document.getElementById("pageLabel"),
  prev: document.getElementById("prevButton"),
  next: document.getElementById("nextButton"),
  exportButton: document.getElementById("exportButton"),
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function csvCell(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

async function load() {
  const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  const search = elements.search.value.trim();
  if (search) params.set("q", search);
  const hasSubmit = elements.hasSubmit.value;
  if (hasSubmit) params.set("has_submit", hasSubmit);
  elements.status.textContent = "加载中…";
  try {
    const response = await fetch(`/api/submit-sites?${params.toString()}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || response.status);
    state.items = payload.items || [];
    state.total = payload.total || 0;
    render();
  } catch (error) {
    elements.status.textContent = `加载失败：${error.message}`;
  }
}

function render() {
  const start = state.total ? state.offset + 1 : 0;
  const end = Math.min(state.offset + state.items.length, state.total);
  elements.status.textContent = `共 ${state.total} 个站点，显示 ${start}-${end}`;
  elements.pageLabel.textContent = `第 ${Math.floor(state.offset / state.limit) + 1} 页`;
  elements.prev.disabled = state.offset <= 0;
  elements.next.disabled = state.offset + state.limit >= state.total;

  if (!state.items.length) {
    elements.rows.innerHTML = '<tr><td colspan="8">没有匹配的站点</td></tr>';
    return;
  }

  elements.rows.innerHTML = state.items
    .map((item) => {
      const submit = item.has_submit ? '<span class="status-pill">✓ submit</span>' : "—";
      const evidence = item.submit_url
        ? `${escapeHtml(item.evidence || "")}<br><a href="${escapeHtml(item.submit_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.submit_url)}</a>`
        : escapeHtml(item.evidence || item.check_error || "");
      return `<tr>
        <td><a href="${escapeHtml(item.url || `https://${item.host}/`)}" target="_blank" rel="noreferrer">${escapeHtml(item.host)}</a></td>
        <td>${submit}</td>
        <td>${escapeHtml(item.check_status || "")}</td>
        <td>${escapeHtml(item.as_score == null ? "" : item.as_score)}</td>
        <td>${escapeHtml(item.backlinks == null ? "" : item.backlinks)}</td>
        <td>${escapeHtml(item.source_report || "")}</td>
        <td>${evidence}</td>
        <td>${escapeHtml(item.updated_at || "")}</td>
      </tr>`;
    })
    .join("");
}

function exportCsv() {
  const header = ["域名", "submit", "检测", "AS", "Backlinks", "来源报表", "证据", "提交入口", "更新时间"];
  const lines = [header.map(csvCell).join(",")];
  for (const item of state.items) {
    lines.push([
      item.host,
      item.has_submit ? "是" : "否",
      item.check_status || "",
      item.as_score == null ? "" : item.as_score,
      item.backlinks == null ? "" : item.backlinks,
      item.source_report || "",
      item.evidence || item.check_error || "",
      item.submit_url || "",
      item.updated_at || "",
    ].map(csvCell).join(","));
  }
  const blob = new Blob([`\ufeff${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `submit-sites-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 4000);
}

elements.search.addEventListener("input", () => {
  clearTimeout(elements.search.dataset.timer);
  const timer = setTimeout(() => {
    state.offset = 0;
    load();
  }, 300);
  elements.search.dataset.timer = timer;
});
elements.hasSubmit.addEventListener("change", () => {
  state.offset = 0;
  load();
});
elements.limit.addEventListener("change", () => {
  state.limit = Number(elements.limit.value) || 200;
  state.offset = 0;
  load();
});
elements.prev.addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  load();
});
elements.next.addEventListener("click", () => {
  state.offset += state.limit;
  load();
});
elements.exportButton.addEventListener("click", exportCsv);

load();
