(async () => {
  const popupIds = [
    "gt_rising_popup_v2",
    "gt_rising_popup_v3",
    "gt_rising_popup_v4",
    "gt_rising_popup_v5",
    "gt_rising_popup_v6",
    "gt_rising_popup_v7",
    "gt_rising_popup_v8",
    "gt_rising_popup_v9",
    "gt_rising_popup_v10",
    "gt_rising_popup_v15",
  ];
  popupIds.forEach((id) => document.getElementById(id)?.remove());

  const stateKey = "__GT_RISING_ROWS_V15__";
  const popupId = "gt_rising_popup_v15";
  let rows = window[stateKey] || [];
  window[stateKey] = rows;

  let box = document.getElementById(popupId);
  if (!box) {
    box = document.createElement("div");
    box.id = popupId;
    box.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:16px",
      "width:700px",
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
      '<span data-x="status" style="flex:1;color:#5f6368">ready</span>',
      '<label style="display:flex;align-items:center;gap:4px;color:#5f6368">count <input data-x="category-count" type="number" value="1" min="-1" step="1" style="width:56px;padding:3px 5px;border:1px solid #dadce0;border-radius:4px"></label>',
      '<button data-x="collect">collect</button>',
      '<button data-x="save">save TSV</button>',
      '<button data-x="copy">copy TSV</button>',
      '<button data-x="clear">clear</button>',
      '<button data-x="close">close</button>',
      '</div>',
      '<div data-x="body" style="padding:10px;overflow:auto;max-height:72vh"></div>',
    ].join("");
    document.body.appendChild(box);
  }

  const statusEl = box.querySelector('[data-x="status"]');
  const bodyEl = box.querySelector('[data-x="body"]');
  const collectButton = box.querySelector('[data-x="collect"]');
  const categoryCountInput = box.querySelector('[data-x="category-count"]');
  const setStatus = (value) => { statusEl.textContent = value; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));

  let collecting = false;

  const categories = [
    ["0", "\u6240\u6709\u7c7b\u522b"],
    ["65", "\u7231\u597d\u4e0e\u4f11\u95f2"],
    ["533", "\u53c2\u8003\u4fe1\u606f"],
    ["71", "\u9910\u996e"],
    ["66", "\u5ba0\u7269\u4e0e\u52a8\u7269"],
    ["19", "\u6cd5\u5f8b\u548c\u653f\u5e9c"],
    ["29", "\u623f\u5730\u4ea7"],
    ["12", "\u5de5\u5546\u4e1a"],
    ["18", "\u8d2d\u7269"],
    ["13", "\u4e92\u8054\u7f51\u4e0e\u7535\u4fe1"],
    ["5", "\u8ba1\u7b97\u673a\u4e0e\u7535\u5b50\u4ea7\u54c1"],
    ["11", "\u5bb6\u5c45\u4e0e\u56ed\u827a"],
    ["45", "\u5065\u5eb7"],
    ["7", "\u91d1\u878d"],
    ["174", "\u79d1\u5b66"],
    ["67", "\u65c5\u6e38"],
    ["44", "\u7f8e\u5bb9\u4e0e\u5065\u8eab"],
    ["47", "\u6c7d\u8f66\u4e0e\u8f66\u8f86"],
    ["958", "\u6c42\u804c\u4e0e\u6559\u80b2"],
    ["14", "\u4eba\u4e0e\u793e\u4f1a"],
    ["20", "\u4f53\u80b2"],
    ["22", "\u56fe\u4e66\u4e0e\u6587\u5b66"],
    ["16", "\u65b0\u95fb"],
    ["3", "\u827a\u672f\u4e0e\u5a31\u4e50"],
    ["8", "\u6e38\u620f"],
    ["299", "\u5728\u7ebf\u793e\u533a"],
  ];

  function meta(targetWindow = window) {
    const params = new URL(targetWindow.location.href).searchParams;
    return {
      url: targetWindow.location.href,
      geo: params.get("geo") || "GLOBAL",
      cat: params.get("cat") || "0",
      date: params.get("date") || "",
    };
  }

  function dateStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function outputFilename() {
    return `google_trends_rising_${dateStamp()}.tsv`;
  }

  async function saveToLocalDirectory(filename, content) {
    const receiverOrigin = "http://127.0.0.1:18765";
    const payload = JSON.stringify({ type: "gt-save", filename, content });
    const receiver = window.open("about:blank", "gt_local_saver", "width=560,height=260");
    if (!receiver) throw new Error("popup blocked: allow popups for this page");

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("local saver did not respond"));
      }, 8000);

      function onMessage(event) {
        if (event.origin !== receiverOrigin) return;
        const data = event.data || {};
        if (data.type !== "gt-save-result") return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (data.ok) resolve(data.path || filename);
        else reject(new Error(data.error || "local save failed"));
      }

      window.addEventListener("message", onMessage);

      receiver.name = payload;
      receiver.location = `${receiverOrigin}/receiver`;
    });
  }

  function categoryCount() {
    const value = Number(categoryCountInput?.value || 1);
    if (value === -1) return -1;
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.floor(value);
  }

  function categorySequence(currentCat, count) {
    if (count === -1) return categories.map(([id]) => id);
    const ids = categories.map(([id]) => id);
    const start = Math.max(0, ids.indexOf(String(currentCat)));
    if (ids.includes(String(currentCat))) return ids.slice(start, start + count);
    return [String(currentCat), ...ids.filter((id) => id !== String(currentCat))].slice(0, count);
  }

  function categoryName(cat) {
    return categories.find(([id]) => id === String(cat))?.[1] || String(cat || "");
  }

  function buildCategoryUrl(baseUrl, cat) {
    const url = new URL(baseUrl);
    url.searchParams.set("cat", cat);
    return url.href;
  }

  async function waitForTargetReady(targetWindow) {
    for (let attempt = 0; attempt < 140; attempt += 1) {
      await sleep(500);
      try {
        if (targetWindow.closed) throw new Error("collector window was closed");
        const text = (targetWindow.document.body?.innerText || targetWindow.document.body?.textContent || "")
          .replace(/[\u202a-\u202e]/g, "");
        if (/429|Too Many Requests|unusual traffic/i.test(text)) {
          throw new Error(`RATE_LIMIT: ${text.slice(0, 240)}`);
        }
        if (/\u641c\u7d22\u67e5\u8be2|Related queries|Consultas de pesquisa/i.test(text) &&
            /\u641c\u7d22\u91cf\u4e0a\u5347|Rising|Em ascens/i.test(text)) {
          targetWindow.scrollTo({ top: targetWindow.document.body.scrollHeight, behavior: "instant" });
          await sleep(800);
          return;
        }
        if (attempt > 3) {
          targetWindow.scrollTo({ top: targetWindow.document.body.scrollHeight, behavior: "instant" });
        }
      } catch (error) {
        if (/RATE_LIMIT/.test(error.message || "")) throw error;
      }
    }
    throw new Error("target page not ready: related queries widget was not visible");
  }

  function pageText(targetWindow = window) {
    const previousDisplay = box.style.display;
    box.style.display = "none";
    const value = (targetWindow.document.body.innerText || targetWindow.document.body.textContent || "")
      .replace(/[\u202a-\u202e]/g, "");
    box.style.display = previousDisplay;
    return value;
  }

  function parseCurrentPage(targetWindow = window) {
    const allText = pageText(targetWindow);
    const queryTitle = "\u641c\u7d22\u67e5\u8be2";
    const start = allText.lastIndexOf(queryTitle);
    if (start < 0) {
      throw new Error("not found: search query block. Open a Google Trends Explore page, scroll to bottom, wait for the related queries module, then click collect.");
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
    const currentMeta = meta(targetWindow);

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

      if (query) parsed.push({ ...currentMeta, query, translation, change });
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

  function pagerButton(direction, targetWindow = window) {
    const labels = direction === "next"
      ? ["\u4e0b\u4e00\u9875", "Next", "Pr\u00f3xima", "Suivant"]
      : ["\u4e0a\u4e00\u9875", "Previous", "Prev", "Anterior", "Pr\u00e9c\u00e9dent"];
    const buttons = Array.from(targetWindow.document.querySelectorAll("button")).filter((button) => {
      const label = (button.getAttribute("aria-label") || "").trim();
      return labels.includes(label) &&
        !button.disabled &&
        button.getAttribute("aria-disabled") !== "true";
    });
    return buttons[buttons.length - 1] || null;
  }

  async function waitForChange(previousSignature, targetWindow = window) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(350);
      targetWindow.scrollTo({ top: targetWindow.document.body.scrollHeight, behavior: "instant" });
      try {
        const current = parseCurrentPage(targetWindow);
        if (current.signature && current.signature !== previousSignature) return true;
      } catch {
      }
    }
    return false;
  }

  function uniqueRows(value) {
    return Array.from(new Map(value.map((row) => [
      `${row.geo}|${row.cat}|${row.date}|${row.query}`,
      row,
    ])).values());
  }

  function makeTsv(value) {
    return [
      "geo\tcat\tdate\tquery\ttranslation\tchange",
      ...uniqueRows(value).map((row) => [
        row.geo,
        categoryName(row.cat),
        row.date,
        row.query,
        row.translation,
        row.change,
      ].join("\t")),
    ].join("\n");
  }

  function render(debug = "") {
    const currentRows = uniqueRows(rows);
    bodyEl.innerHTML = [
      `<div style="margin-bottom:8px;color:#5f6368">total rows: ${currentRows.length}</div>`,
      '<table style="border-collapse:collapse;width:100%;font-size:12px">',
      '<thead><tr><th align="left">geo</th><th align="left">cat</th><th align="left">date</th><th align="left">query</th><th align="left">translation</th><th align="left">change</th></tr></thead>',
      '<tbody>',
      currentRows.map((row) => `<tr><td>${escapeHtml(row.geo)}</td><td>${escapeHtml(categoryName(row.cat))}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.query)}</td><td>${escapeHtml(row.translation)}</td><td>${escapeHtml(row.change)}</td></tr>`).join(""),
      '</tbody></table>',
      debug ? `<details style="margin-top:8px"><summary>debug</summary><pre style="white-space:pre-wrap">${escapeHtml(debug)}</pre></details>` : "",
    ].join("");
  }

  async function collectSingleCategory(targetWindow, label) {
    if (targetWindow.closed) throw new Error("collector window was closed");
    await waitForTargetReady(targetWindow);

    targetWindow.scrollTo({ top: targetWindow.document.body.scrollHeight, behavior: "instant" });
    await sleep(1000);

    setStatus(`${label}: moving to first page`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = parseCurrentPage(targetWindow);
      if (current.from === 1) break;
      const previous = pagerButton("prev", targetWindow);
      if (!previous) break;
      previous.click();
      await waitForChange(current.signature, targetWindow);
    }

    const localRows = [];
    let expectedTotal = null;
    for (let page = 0; page < 20; page += 1) {
      if (targetWindow.closed) throw new Error("collector window was closed");
      const current = parseCurrentPage(targetWindow);
      expectedTotal = current.total || expectedTotal;
      setStatus(`${label}: reading ${current.from || "?"}-${current.to || "?"} / ${expectedTotal || "?"}`);
      localRows.push(...current.rows);
      rows.push(...current.rows);
      window[stateKey] = rows;
      render(current.rows.length ? "" : current.debug);

      if (expectedTotal && uniqueRows(localRows).length >= expectedTotal) break;
      const next = pagerButton("next", targetWindow);
      if (!next) break;
      next.click();
      const changed = await waitForChange(current.signature, targetWindow);
      if (!changed) break;
    }

    return uniqueRows(localRows).length;
  }

  function isRateLimitError(error) {
    return /RATE_LIMIT|429|Too Many Requests|unusual traffic/i.test(error?.message || String(error || ""));
  }

  async function collectRows() {
    if (collecting) return;
    collecting = true;
    collectButton.disabled = true;
    if (categoryCountInput) categoryCountInput.disabled = true;
    const beforeCollectCount = uniqueRows(rows).length;

    try {
      const current = meta(window);
      const count = categoryCount();
      const cats = categorySequence(current.cat, count);
      const baseUrl = window.location.href;
      const useCollectorWindow = cats.length > 1 || cats[0] !== current.cat;
      const targetWindow = useCollectorWindow
        ? window.open("about:blank", "gt_category_collector", "width=1280,height=900")
        : window;
      if (!targetWindow) throw new Error("collector popup blocked: allow popups for this page");

      const failures = [];
      let stoppedReason = "";
      for (let index = 0; index < cats.length; index += 1) {
        const cat = cats[index];
        const label = `cat ${cat} (${index + 1}/${cats.length})`;
        try {
          if (useCollectorWindow) {
            targetWindow.location.href = buildCategoryUrl(baseUrl, cat);
          }
          setStatus(`${label}: loading`);
          await collectSingleCategory(targetWindow, label);
        } catch (error) {
          failures.push(`${cat}: ${error.message || error}`);
          render(failures.join("\n"));
          if (isRateLimitError(error)) {
            stoppedReason = `stopped by rate limit at ${label}`;
            setStatus(`${stoppedReason}; total ${uniqueRows(rows).length}`);
            break;
          }
          setStatus(`${label}: failed, continuing`);
          await sleep(2500);
        }
        if (index < cats.length - 1) await sleep(1500);
      }

      const suffix = failures.length ? `, failed cats ${failures.length}` : "";
      if (stoppedReason) {
        setStatus(`${stoppedReason}, added ${uniqueRows(rows).length - beforeCollectCount}, total ${uniqueRows(rows).length}${suffix}`);
      } else {
        setStatus(`done, added ${uniqueRows(rows).length - beforeCollectCount}, total ${uniqueRows(rows).length}${suffix}`);
      }
      render(failures.join("\n"));
    } catch (error) {
      setStatus("failed");
      bodyEl.innerHTML = `<pre style="white-space:pre-wrap;color:#b00020">${escapeHtml(error.message || error)}</pre>${bodyEl.innerHTML}`;
    } finally {
      collecting = false;
      collectButton.disabled = false;
      if (categoryCountInput) categoryCountInput.disabled = false;
    }
  }

  box.querySelector('[data-x="collect"]').onclick = collectRows;
  box.querySelector('[data-x="close"]').onclick = () => box.remove();
  box.querySelector('[data-x="clear"]').onclick = () => {
    rows = [];
    window[stateKey] = rows;
    render();
    setStatus("cleared");
  };
  box.querySelector('[data-x="copy"]').onclick = async () => {
    const output = makeTsv(rows);
    const textarea = document.createElement("textarea");
    textarea.value = output;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:2147483647";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("execCommand copy returned false");
      setStatus("copied");
    } catch (error) {
      textarea.remove();
      try {
        await navigator.clipboard.writeText(output);
        setStatus("copied");
      } catch (clipboardError) {
        setStatus(`copy failed: ${clipboardError.message || clipboardError || error}`);
      }
    }
  };
  box.querySelector('[data-x="save"]').onclick = async () => {
    const filename = outputFilename();
    const output = makeTsv(rows);
    try {
      const path = await saveToLocalDirectory(filename, output);
      setStatus(`saved: ${path}`);
    } catch (error) {
      setStatus(`local save failed: ${error.message || error}`);
    }
  };

  render();
  setStatus("ready");
})();
