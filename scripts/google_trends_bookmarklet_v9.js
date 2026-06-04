(async () => {
  const POPUP_IDS = [
    "gt_rising_popup_v2",
    "gt_rising_popup_v3",
    "gt_rising_popup_v4",
    "gt_rising_popup_v5",
    "gt_rising_popup_v6",
    "gt_rising_popup_v7",
    "gt_rising_popup_v8",
    "gt_rising_popup_v9",
  ];
  POPUP_IDS.forEach((id) => document.getElementById(id)?.remove());

  const box = document.createElement("div");
  box.id = "gt_rising_popup_v9";
  box.style.cssText = [
    "position:fixed",
    "right:16px",
    "top:16px",
    "width:620px",
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
  box.innerHTML = [
    '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafd;border-bottom:1px solid #e8eaed">',
    '<b style="font-size:14px">Google Trends Rising Queries</b>',
    '<span data-x="status" style="flex:1;color:#5f6368">starting...</span>',
    '<button data-x="save">save TSV</button>',
    '<button data-x="copy">copy TSV</button>',
    '<button data-x="close">close</button>',
    '</div>',
    '<div data-x="body" style="padding:10px;overflow:auto;max-height:72vh"></div>',
  ].join("");
  document.body.appendChild(box);

  const statusEl = box.querySelector('[data-x="status"]');
  const bodyEl = box.querySelector('[data-x="body"]');
  const setStatus = (value) => { statusEl.textContent = value; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));

  let rows = [];
  let tsv = "";

  function dateStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function outputFilename() {
    const params = new URL(location.href).searchParams;
    const geo = params.get("geo") || "GLOBAL";
    const cat = params.get("cat") || "0";
    return `google_trends_${geo}_cat${cat}_rising_${dateStamp()}.tsv`;
  }

  function hiddenPageText() {
    const previousDisplay = box.style.display;
    box.style.display = "none";
    const value = (document.body.innerText || document.body.textContent || "")
      .replace(/[\u202a-\u202e]/g, "");
    box.style.display = previousDisplay;
    return value;
  }

  function parseCurrentPage() {
    const allText = hiddenPageText();
    const queryTitle = "\u641c\u7d22\u67e5\u8be2";
    const start = allText.lastIndexOf(queryTitle);
    if (start < 0) {
      throw new Error("not found: search query block. scroll to bottom and wait for it to load.");
    }

    const section = allText.slice(start);
    const rangeMatch =
      section.match(/\u5f53\u524d\u663e\u793a\u7684\u662f\u7b2c\s*(\d+)\s*[-–]\s*(\d+)\s*\u4e2a\u67e5\u8be2[\uff08(]\u5171\s*(\d+)\s*\u4e2a[\uff09)]/) ||
      section.match(/Showing\s*(\d+)\s*[-–]\s*(\d+)\s*of\s*(\d+)/i) ||
      section.match(/Mostrando\s*(\d+)\s*a\s*(\d+)\s*de\s*(\d+)/i);
    const from = rangeMatch ? Number(rangeMatch[1]) : null;
    const to = rangeMatch ? Number(rangeMatch[2]) : null;
    const total = rangeMatch ? Number(rangeMatch[3]) : null;
    const block = rangeMatch ? section.slice(0, rangeMatch.index) : section;
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const skip = /help_outline|file_download|code|share|more_vert|\u641c\u7d22\u67e5\u8be2|\u641c\u7d22\u91cf\u4e0a\u5347|\u70ed\u95e8|\u5206\u6790|\u4e0b\u8f7d|\u5d4c\u5165/i;
    const parsed = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\d+$/.test(lines[index])) continue;

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
        if (/\u98d9\u5347|Breakout|Aumento repentino|^Mais\s+/i.test(line) || /^\+[\d,.]+[%\uff05]?$/.test(line)) {
          change = line.replace(/^Mais\s+/i, "+");
          break;
        }
        if (!translation) {
          translation = line;
          continue;
        }
      }

      if (query) parsed.push({ query, translation, change });
    }

    return {
      from,
      to,
      total,
      rows: parsed,
      signature: parsed.map((row) => `${row.query}|${row.change}`).join("||"),
      debug: lines.slice(0, 40).join("\n"),
    };
  }

  function pagerButton(direction) {
    const labels = direction === "next"
      ? ["\u4e0b\u4e00\u9875", "Next", "Pr\u00f3xima", "Suivant"]
      : ["\u4e0a\u4e00\u9875", "Previous", "Prev", "Anterior", "Pr\u00e9c\u00e9dent"];
    const buttons = Array.from(document.querySelectorAll("button")).filter((button) => {
      const label = (button.getAttribute("aria-label") || "").trim();
      return labels.includes(label) &&
        !button.disabled &&
        button.getAttribute("aria-disabled") !== "true";
    });
    return buttons[buttons.length - 1] || null;
  }

  async function waitForChange(previousSignature) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(350);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      try {
        const current = parseCurrentPage();
        if (current.signature && current.signature !== previousSignature) return true;
      } catch {
        // Keep waiting while Google swaps page content.
      }
    }
    return false;
  }

  function uniqueRows(value) {
    return Array.from(new Map(value.map((row) => [row.query, row])).values());
  }

  function makeTsv(value) {
    return [
      "query\ttranslation\tchange",
      ...uniqueRows(value).map((row) => [row.query, row.translation, row.change].join("\t")),
    ].join("\n");
  }

  function render(done, debug = "") {
    const currentRows = uniqueRows(rows);
    tsv = makeTsv(currentRows);
    bodyEl.innerHTML = [
      `<div style="margin-bottom:8px;color:#5f6368">rows: ${currentRows.length}${done ? " done" : " running"}</div>`,
      '<table style="border-collapse:collapse;width:100%;font-size:12px">',
      '<thead><tr><th align="left">query</th><th align="left">translation</th><th align="left">change</th></tr></thead>',
      '<tbody>',
      currentRows.map((row) => `<tr><td>${escapeHtml(row.query)}</td><td>${escapeHtml(row.translation)}</td><td>${escapeHtml(row.change)}</td></tr>`).join(""),
      '</tbody></table>',
      debug ? `<details style="margin-top:8px"><summary>debug</summary><pre style="white-space:pre-wrap">${escapeHtml(debug)}</pre></details>` : "",
    ].join("");
  }

  box.querySelector('[data-x="close"]').onclick = () => box.remove();
  box.querySelector('[data-x="copy"]').onclick = async () => {
    tsv = makeTsv(rows);
    try {
      await navigator.clipboard.writeText(tsv);
      setStatus("copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = tsv;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setStatus("copied");
    }
  };
  box.querySelector('[data-x="save"]').onclick = () => {
    tsv = makeTsv(rows);
    const blob = new Blob([tsv], { type: "text/tab-separated-values;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = outputFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus("saved");
  };

  try {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    await sleep(1000);

    setStatus("moving to first page");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = parseCurrentPage();
      if (current.from === 1) break;
      const previous = pagerButton("prev");
      if (!previous) break;
      previous.click();
      await waitForChange(current.signature);
    }

    let expectedTotal = null;
    for (let page = 0; page < 20; page += 1) {
      const current = parseCurrentPage();
      expectedTotal = current.total || expectedTotal;
      setStatus(`reading ${current.from || "?"}-${current.to || "?"} / ${expectedTotal || "?"}`);
      rows.push(...current.rows);
      render(false, current.rows.length ? "" : current.debug);

      if (expectedTotal && uniqueRows(rows).length >= expectedTotal) break;
      const next = pagerButton("next");
      if (!next) break;
      next.click();
      const changed = await waitForChange(current.signature);
      if (!changed) break;
    }

    render(true);
    setStatus("done");
  } catch (error) {
    setStatus("failed");
    bodyEl.innerHTML = `<pre style="white-space:pre-wrap;color:#b00020">${escapeHtml(error.message || error)}</pre>${bodyEl.innerHTML}`;
  }
})();
