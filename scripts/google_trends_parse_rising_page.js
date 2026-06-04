(function () {
  function text(element) {
    return (element && (element.innerText || element.textContent) || "").trim();
  }

  function clean(value) {
    return String(value || "")
      .replace(/[\t\r\n]+/g, " ")
      .replace(/[\u202a-\u202e]/g, "")
      .trim();
  }

  function findWidget() {
    const widgets = Array.from(document.querySelectorAll(".fe-related-queries"));
    return widgets.find((widget) => {
      const value = text(widget);
      return /搜索查询|Related queries|Consultas de pesquisa/i.test(value) &&
        /搜索量上升|Rising|Em ascensão/i.test(value);
    }) || widgets.find((widget) => /搜索查询|Related queries/i.test(text(widget))) || widgets[1] || widgets[0];
  }

  const widget = findWidget();
  if (!widget) {
    return JSON.stringify({ ok: false, error: "NO_WIDGET", body: text(document.body).slice(0, 800) });
  }

  const raw = text(widget);
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const skip = /help_outline|file_download|code|share|more_vert|搜索查询|搜索量上升|热门|分析|当前显示|Showing|第\s*\d+[-–]\d+|个查询|共\s*\d+|查询|下载|嵌入/i;
  const rows = [];
  let total = null;
  let visible = null;

  const visibleMatch = raw.match(/当前显示的是第\s*(\d+)\s*[-–]\s*(\d+)\s*个查询[（(]共\s*(\d+)\s*个[）)]/);
  if (visibleMatch) {
    visible = {
      from: Number(visibleMatch[1]),
      to: Number(visibleMatch[2]),
    };
    total = Number(visibleMatch[3]);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\d+$/.test(lines[index])) continue;

    const rank = Number(lines[index]);
    let query = "";
    let translation = "";
    let change = "";

    for (let cursor = index + 1; cursor < Math.min(index + 10, lines.length); cursor += 1) {
      const line = lines[cursor];
      if (skip.test(line) || /^\d+$/.test(line) || /^\.\.\.$/.test(line)) continue;
      if (!query) {
        query = line;
        continue;
      }
      if (/飙升|Breakout|^Mais\s+/i.test(line) || /^\+[\d,.]+[%％]?$/.test(line)) {
        change = line;
        break;
      }
      if (!translation) {
        translation = line;
        continue;
      }
    }

    if (query) {
      rows.push({
        rank,
        query: clean(query),
        translation: clean(translation),
        change: clean(change),
      });
    }
  }

  return JSON.stringify({
    ok: true,
    url: location.href,
    visible,
    total,
    rows,
    raw: raw.slice(0, 1500),
  });
})();
