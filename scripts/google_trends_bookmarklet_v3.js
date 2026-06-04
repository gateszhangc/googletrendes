(async () => {
  const ID = "gt_rising_popup_v3";
  document.getElementById(ID)?.remove();

  const box = document.createElement("div");
  box.id = ID;
  box.style.cssText = [
    "position:fixed",
    "right:16px",
    "top:16px",
    "width:640px",
    "max-height:82vh",
    "z-index:2147483647",
    "background:#fff",
    "color:#202124",
    "border:1px solid #dadce0",
    "box-shadow:0 8px 28px rgba(0,0,0,.28)",
    "border-radius:8px",
    "font:12px Arial,sans-serif",
    "overflow:hidden",
  ].join(";");
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafd;border-bottom:1px solid #e8eaed">
      <b style="font-size:14px">Google Trends 上升查询提取</b>
      <span data-role="status" style="flex:1;color:#5f6368">启动中...</span>
      <button data-role="copy">复制TSV</button>
      <button data-role="close">关闭</button>
    </div>
    <div data-role="body" style="padding:10px;overflow:auto;max-height:72vh"></div>
  `;
  document.body.appendChild(box);

  const statusEl = box.querySelector('[data-role="status"]');
  const bodyEl = box.querySelector('[data-role="body"]');
  const setStatus = (value) => { statusEl.textContent = value; };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let rows = [];
  let tsv = "";

  box.querySelector('[data-role="close"]').onclick = () => box.remove();
  box.querySelector('[data-role="copy"]').onclick = async () => {
    tsv = buildTsv(rows);
    try {
      await navigator.clipboard.writeText(tsv);
      setStatus("已复制 TSV");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = tsv;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setStatus("已复制 TSV");
    }
  };

  function bodyText() {
    return (document.body.innerText || document.body.textContent || "").replace(/[\u202a-\u202e]/g, "");
  }

  function parseQueryPage(page) {
    const all = bodyText();
    const index = all.lastIndexOf("搜索查询");
    if (index < 0) {
      throw new Error("没找到“搜索查询”模块。请先滚动到底部，等搜索查询模块加载出来后再点书签。");
    }

    const part = all.slice(index);
    const totalMatch =
      part.match(/当前显示的是第\s*(\d+)\s*[-–]\s*(\d+)\s*个查询[（(]共\s*(\d+)\s*个[）)]/) ||
      part.match(/Showing\s*(\d+)\s*[-–]\s*(\d+)\s*of\s*(\d+)/i) ||
      part.match(/Mostrando\s*(\d+)\s*a\s*(\d+)\s*de\s*(\d+)/i);
    const total = totalMatch ? Number(totalMatch[3]) : null;
    const block = totalMatch ? part.slice(0, totalMatch.index) : part;
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const skip = /help_outline|file_download|code|share|more_vert|搜索查询|搜索量上升|热门|分析|下载|嵌入/i;
    const parsed = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\d+$/.test(lines[index])) continue;

      const rank = Number(lines[index]);
      let query = "";
      let translation = "";
      let change = "";

      for (let cursor = index + 1; cursor < Math.min(index + 10, lines.length); cursor += 1) {
        const line = lines[cursor];
        if (skip.test(line) || /^\d+$/.test(line) || line === "...") continue;
        if (!query) {
          query = line;
          continue;
        }
        if (/飙升|Breakout|Aumento repentino|^Mais\s+/i.test(line) || /^\+[\d,.]+[%％]?$/.test(line)) {
          change = line.replace(/^Mais\s+/i, "+");
          break;
        }
        if (!translation) {
          translation = line;
          continue;
        }
      }

      if (query) parsed.push({ page, rank, query, translation, change });
    }

    return {
      total,
      rows: parsed,
      signature: parsed.map((row) => `${row.rank}|${row.query}|${row.change}`).join("||"),
      debugLines: lines.slice(0, 40),
    };
  }

  function findNextButton() {
    const buttons = Array.from(document.querySelectorAll([
      'button[aria-label="下一页"]',
      'button[aria-label="Next"]',
      'button[aria-label="Próxima"]',
      'button[aria-label="Suivant"]',
    ].join(","))).filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
    return buttons[buttons.length - 1] || null;
  }

  function normalizeRows(value) {
    return Array.from(new Map(value.map((row) => [`${row.rank}|${row.query}`, row])).values())
      .sort((left, right) => left.rank - right.rank);
  }

  function buildTsv(value) {
    return [
      "page\trank\tquery\ttranslation\tchange",
      ...normalizeRows(value).map((row) => [row.page, row.rank, row.query, row.translation, row.change].join("\t")),
    ].join("\n");
  }

  function render(done, debug) {
    const normalized = normalizeRows(rows);
    tsv = buildTsv(normalized);
    bodyEl.innerHTML = `
      <div style="margin-bottom:8px;color:#5f6368">已提取 ${normalized.length} 条${done ? "，完成" : "，继续翻页中..."}</div>
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <thead>
          <tr>
            <th align="left">页</th>
            <th align="left">排名</th>
            <th align="left">关键词</th>
            <th align="left">翻译</th>
            <th align="left">涨幅</th>
          </tr>
        </thead>
        <tbody>
          ${normalized.map((row) => `
            <tr>
              <td>${row.page}</td>
              <td>${row.rank}</td>
              <td>${escapeHtml(row.query)}</td>
              <td>${escapeHtml(row.translation)}</td>
              <td>${escapeHtml(row.change)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${debug ? `<details style="margin-top:10px"><summary>调试信息</summary><pre style="white-space:pre-wrap">${escapeHtml(debug)}</pre></details>` : ""}
    `;
  }

  try {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    await sleep(1000);

    let total = null;
    for (let page = 1; page <= 20; page += 1) {
      setStatus(`读取第 ${page} 页...`);
      const current = parseQueryPage(page);
      total = current.total || total;
      rows.push(...current.rows);
      render(false, current.rows.length === 0 ? current.debugLines.join("\n") : "");

      const maxRank = Math.max(0, ...rows.map((row) => row.rank));
      if (total && maxRank >= total) break;

      const button = findNextButton();
      if (!button) break;

      const before = current.signature;
      button.click();

      let changed = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(350);
        window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
        const next = parseQueryPage(page + 1);
        if (next.signature && next.signature !== before) {
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }

    render(true, "");
    setStatus("完成");
  } catch (error) {
    setStatus("失败");
    bodyEl.innerHTML = `<pre style="white-space:pre-wrap;color:#b00020">${escapeHtml(error.message || error)}</pre>${bodyEl.innerHTML}`;
  }
})();
