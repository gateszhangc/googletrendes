(function () {
  const CONFIG = {
    maxPages: 20,
    pageSize: 5,
    settleMs: 900,
    clickWaitMs: 1800,
    stateKey: "__GT_RISING_EXTRACTOR_STATE",
  };

  function text(element) {
    return (element && (element.innerText || element.textContent) || "").trim();
  }

  function clean(value) {
    return String(value || "")
      .replace(/[\t\r\n]+/g, " ")
      .replace(/[\u202a-\u202e]/g, "")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findRisingWidget() {
    const widgets = Array.from(document.querySelectorAll(".fe-related-queries"));
    return widgets.find((widget) => {
      const value = text(widget);
      return /搜索查询|Related queries|Consultas de pesquisa|Consultas relacionadas/i.test(value) &&
        /搜索量上升|Rising|Em ascensão|Em alta/i.test(value);
    }) || widgets.find((widget) => {
      const value = text(widget);
      return /搜索查询|Related queries/i.test(value) && !/热门|Top/i.test(value);
    }) || widgets[1] || widgets[0];
  }

  function parseVisibleRange(raw) {
    const patterns = [
      /当前显示的是第\s*(\d+)\s*[-–]\s*(\d+)\s*个查询[（(]共\s*(\d+)\s*个[）)]/,
      /Showing\s*(\d+)\s*[-–]\s*(\d+)\s*of\s*(\d+)\s*quer/i,
      /Mostrando\s*(\d+)\s*a\s*(\d+)\s*de\s*(\d+)\s*consultas/i,
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) {
        return {
          visible: { from: Number(match[1]), to: Number(match[2]) },
          total: Number(match[3]),
        };
      }
    }
    return { visible: null, total: null };
  }

  function parsePage(pageNumber) {
    const widget = findRisingWidget();
    if (!widget) {
      return {
        ok: false,
        error: "NO_WIDGET",
        rows: [],
        body: text(document.body).slice(0, 1200),
      };
    }
    widget.scrollIntoView({ block: "center", inline: "nearest" });

    const raw = text(widget);
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const skip = /help_outline|file_download|code|share|more_vert|搜索查询|搜索量上升|热门|分析|当前显示|Showing|Mostrando|第\s*\d+[-–]\d+|个查询|共\s*\d+|查询|下载|嵌入/i;
    const rows = [];
    const range = parseVisibleRange(raw);

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\d+$/.test(lines[index])) continue;

      const rank = Number(lines[index]);
      let query = "";
      let translation = "";
      let change = "";

      for (let cursor = index + 1; cursor < Math.min(index + 12, lines.length); cursor += 1) {
        const line = lines[cursor];
        if (skip.test(line) || /^\d+$/.test(line) || /^\.\.\.$/.test(line)) continue;
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

      if (query) {
        rows.push({
          page: pageNumber,
          rank,
          query: clean(query),
          translation: clean(translation),
          change: clean(change),
        });
      }
    }

    return {
      ok: true,
      url: location.href,
      visible: range.visible,
      total: range.total,
      rowCount: rows.length,
      rows,
      signature: rows.map((row) => `${row.rank}:${row.query}:${row.change}`).join("|"),
      raw: raw.slice(0, 1800),
    };
  }

  function nextButton() {
    const widget = findRisingWidget();
    const scopes = [];
    for (let node = widget, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      scopes.push(node);
    }
    scopes.push(document);

    for (const scope of scopes) {
      const buttons = Array.from(scope.querySelectorAll([
        'button[aria-label="下一页"]',
        'button[aria-label="Next"]',
        'button[aria-label="Próxima"]',
        'button[aria-label="Suivant"]',
      ].join(",")));
      for (const button of buttons) {
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      }
    }
    return null;
  }

  function pageMetadata() {
    const params = new URL(location.href).searchParams;
    return {
      pageUrl: location.href,
      geo: params.get("geo") || "",
      categoryId: params.get("cat") || "0",
      date: params.get("date") || "",
      hl: params.get("hl") || document.documentElement.lang || "",
    };
  }

  function uniqueRows(rows) {
    const seen = new Set();
    return rows
      .filter((row) => {
        const key = `${row.rank}\t${row.query}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => left.rank - right.rank)
      .map((row) => ({ ...row, page: Math.floor((row.rank - 1) / CONFIG.pageSize) + 1 }));
  }

  async function waitForPageReady() {
    for (let attempt = 0; attempt < 140; attempt += 1) {
      const body = text(document.body);
      if (/429|Too Many Requests|unusual traffic/i.test(body)) {
        throw new Error(`RATE_LIMIT: ${body.slice(0, 240)}`);
      }
      if (/搜索查询|Related queries|Consultas de pesquisa/i.test(body) &&
          /搜索量上升|Rising|Em ascensão/i.test(body)) {
        return;
      }
      if (attempt > 3) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      }
      await sleep(500);
    }
    throw new Error("PAGE_NOT_READY: rising related queries widget was not visible");
  }

  async function run() {
    const state = window[CONFIG.stateKey];
    state.status = "running";
    state.startedAt = new Date().toISOString();
    state.pages = [];
    state.error = null;

    await waitForPageReady();

    for (let pageNumber = 1; pageNumber <= CONFIG.maxPages; pageNumber += 1) {
      await sleep(CONFIG.settleMs);
      const parsed = parsePage(pageNumber);
      state.pages.push(parsed);
      state.progress = {
        pageNumber,
        visible: parsed.visible || null,
        total: parsed.total || null,
        rows: state.pages.flatMap((page) => page.rows || []).length,
      };

      if (!parsed.ok) throw new Error(parsed.error || "PARSE_FAILED");

      const maxRank = Math.max(0, ...state.pages.flatMap((page) => (page.rows || []).map((row) => row.rank)));
      if (parsed.total && maxRank >= parsed.total) break;

      const button = nextButton();
      if (!button) break;
      const beforeSignature = parsed.signature;
      button.click();

      for (let waitAttempt = 0; waitAttempt < 20; waitAttempt += 1) {
        await sleep(CONFIG.clickWaitMs / 4);
        const after = parsePage(pageNumber + 1);
        if (after.signature && after.signature !== beforeSignature) break;
      }
    }

    const rows = uniqueRows(state.pages.flatMap((page) => page.rows || []));
    const totals = state.pages.map((page) => page.total).filter((value) => Number.isFinite(value));
    const total = totals.length ? Math.max(...totals) : rows.length;
    state.result = {
      ok: rows.length > 0 && (!total || rows.length >= total),
      status: rows.length > 0 && (!total || rows.length >= total) ? "complete" : "partial",
      capturedAt: new Date().toISOString(),
      ...pageMetadata(),
      total,
      pageCount: state.pages.length,
      pages: state.pages.map((page, index) => ({
        page: index + 1,
        visible: page.visible || null,
        total: page.total || null,
        rowCount: (page.rows || []).length,
        rows: page.rows || [],
      })),
      rows,
    };
    state.status = "done";
    state.finishedAt = new Date().toISOString();
  }

  if (window[CONFIG.stateKey] && window[CONFIG.stateKey].status === "running") {
    return "ALREADY_RUNNING";
  }

  window[CONFIG.stateKey] = {
    status: "starting",
    result: null,
    error: null,
    progress: null,
    pages: [],
  };

  run().catch((error) => {
    window[CONFIG.stateKey].status = "error";
    window[CONFIG.stateKey].error = {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : "",
      at: new Date().toISOString(),
    };
  });

  return "STARTED";
})();
