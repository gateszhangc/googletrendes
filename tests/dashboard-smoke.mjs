import { chromium } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:9876";

const browser = await chromium.launch();
const page = await browser.newPage();
const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#metrics .metric-card");
  await page.waitForSelector("#rows tr");

  const status = await page.textContent("#status");
  if (!status || !status.includes("已同步数据")) {
    throw new Error(`unexpected status: ${status}`);
  }

  const metricCount = await page.locator("#metrics .metric-card").count();
  if (metricCount < 6) {
    throw new Error(`expected 6 metrics, got ${metricCount}`);
  }

  const selectedDate = await page.inputValue("#collectedDate");
  if (!selectedDate) {
    throw new Error("expected latest collected date to be selected by default");
  }

  const batchLabel = await page.textContent("#batchLabel");
  if (!batchLabel || !batchLabel.includes(selectedDate)) {
    throw new Error(`batch label did not include selected date: ${batchLabel}`);
  }

  const resultCount = await page.textContent("#resultCount");
  const selectedDateSummary = await page.evaluate(async (date) => {
    const response = await fetch(`/api/summary?collected_date=${encodeURIComponent(date)}`);
    return response.json();
  }, selectedDate);
  const firstResult = await page.evaluate(async (date) => {
    const response = await fetch(`/api/trends?collected_date=${encodeURIComponent(date)}&limit=1`);
    return response.json();
  }, selectedDate);
  const searchTerm = firstResult.rows[0].query;
  const selectedDateRows = formatNumber(selectedDateSummary.rows);
  if (!resultCount || !resultCount.includes(selectedDateRows)) {
    throw new Error(`default view should be latest date only, got: ${resultCount}`);
  }

  const uniqueResult = await page.evaluate(async (date) => {
    const response = await fetch(`/api/trends?collected_date=${encodeURIComponent(date)}&unique=yes&limit=1`);
    return response.json();
  }, selectedDate);
  const uniqueRows = formatNumber(uniqueResult.total);
  await page.selectOption("#queryMode", "unique");
  await page.waitForFunction((expected) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes(expected);
  }, uniqueRows);

  await page.selectOption("#queryMode", "");
  await page.waitForFunction((expected) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes(expected);
  }, selectedDateRows);

  const typeOptions = await page.locator("#queryType option").allTextContents();
  if (typeOptions.length !== 3) {
    throw new Error(`expected 3 query type options, got ${JSON.stringify(typeOptions)}`);
  }
  const risingSummary = await page.evaluate(async (date) => {
    const response = await fetch(
      `/api/trends?collected_date=${encodeURIComponent(date)}&type=rising&limit=1`
    );
    return response.json();
  }, selectedDate);
  await page.selectOption("#queryType", "rising");
  await page.waitForFunction((expected) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes(expected);
  }, formatNumber(risingSummary.total));
  await page.selectOption("#queryType", "");
  await page.waitForFunction((expected) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes(expected);
  }, selectedDateRows);

  await page.fill("#search", searchTerm);
  await page.waitForFunction((expected) => {
    const rows = document.querySelector("#rows")?.textContent || "";
    return rows.includes(expected);
  }, searchTerm);

  const rowText = await page.locator("#rows tr").first().innerText();
  if (!rowText.includes(searchTerm)) {
    throw new Error(`filtered row did not contain query: ${rowText}`);
  }

  await page.fill("#search", "");
  await page.waitForTimeout(400);
  await page.waitForFunction((expected) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes(expected);
  }, selectedDateRows);
  await page.waitForFunction(() => {
    return document.querySelector("#pageJump")?.value === "1" &&
      document.querySelectorAll("#rows tr").length >= 80;
  });

  const initialRows = await page.locator("#rows tr").count();
  await page.evaluate(() => {
    const wrap = document.querySelector(".table-wrap");
    const maxScroll = wrap.scrollHeight - wrap.clientHeight;
    wrap.scrollTop = Math.ceil(maxScroll * 0.81);
    wrap.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    return document.querySelector("#pageJump")?.value === "2";
  });
  const rowsAfterAutoLoad = await page.locator("#rows tr").count();
  if (rowsAfterAutoLoad <= initialRows) {
    throw new Error(`expected infinite scroll to append rows, got ${initialRows} -> ${rowsAfterAutoLoad}`);
  }

  // 国家 / 分类表头排序：点击后走服务端排序，回到第 1 页，再点一次切降序。
  const sortRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/trends" && url.searchParams.get("sort")) {
      sortRequests.push(`${url.searchParams.get("sort")}:${url.searchParams.get("order")}`);
    }
  });
  const firstColumnValue = async (columnIndex) =>
    page.$eval(`#rows tr:first-child td:nth-child(${columnIndex + 1})`, (cell) => cell.textContent.trim());
  const columnValues = async (columnIndex) =>
    page.$$eval(
      "#rows tr",
      (rows, index) => rows.map((row) => row.children[index].textContent.trim()),
      columnIndex
    );
  const expectSorted = async (columnIndex, direction, label) => {
    try {
      await page.waitForFunction(({ columnIndex, direction }) => {
        const values = [...document.querySelectorAll("#rows tr")]
          .map((row) => row.children[columnIndex]?.textContent.trim() ?? null);
        if (values.length < 2 || values.some((value) => value === null)) return false;
        return values.every((value, index) =>
          index === 0 || (direction === "asc" ? values[index - 1] <= value : values[index - 1] >= value)
        );
      }, { columnIndex, direction });
    } catch {
      const values = await columnValues(columnIndex).catch(() => []);
      throw new Error(`${label} rows are not sorted ${direction}: ${values.slice(0, 6).join(" | ")}`);
    }
    return columnValues(columnIndex);
  };
  const expectedSorted = await page.evaluate(async (date) => {
    const firstRow = async (sort, order) => {
      const response = await fetch(
        `/api/trends?collected_date=${encodeURIComponent(date)}&sort=${sort}&order=${order}&limit=1`
      );
      return (await response.json()).rows[0];
    };
    return {
      geoAsc: (await firstRow("geo", "asc")).geo,
      geoDesc: (await firstRow("geo", "desc")).geo,
      categoryAsc: (await firstRow("category", "asc")).category,
    };
  }, selectedDate);

  await page.click('th[data-sort="geo"]');
  await page.waitForFunction(() =>
    document.querySelector('th[data-sort="geo"]')?.getAttribute("aria-sort") === "ascending" &&
    document.querySelector("#pageJump")?.value === "1"
  );
  await expectSorted(3, "asc", "geo");
  if ((await firstColumnValue(3)) !== expectedSorted.geoAsc) {
    throw new Error(`geo asc first row mismatch: ${await firstColumnValue(3)} vs ${expectedSorted.geoAsc}`);
  }

  await page.click('th[data-sort="geo"]');
  await page.waitForFunction(() =>
    document.querySelector('th[data-sort="geo"]')?.getAttribute("aria-sort") === "descending"
  );
  await expectSorted(3, "desc", "geo");
  if ((await firstColumnValue(3)) !== expectedSorted.geoDesc) {
    throw new Error(`geo desc first row mismatch: ${await firstColumnValue(3)} vs ${expectedSorted.geoDesc}`);
  }

  await page.click('th[data-sort="category"]');
  await page.waitForFunction(() =>
    document.querySelector('th[data-sort="category"]')?.getAttribute("aria-sort") === "ascending" &&
    document.querySelector('th[data-sort="geo"]')?.getAttribute("aria-sort") === "none"
  );
  await expectSorted(4, "asc", "category");
  if ((await firstColumnValue(4)) !== expectedSorted.categoryAsc) {
    throw new Error(`category asc first row mismatch: ${await firstColumnValue(4)} vs ${expectedSorted.categoryAsc}`);
  }
  for (const expected of ["geo:asc", "geo:desc", "category:asc"]) {
    if (!sortRequests.includes(expected)) {
      throw new Error(`expected ${expected} request, got ${JSON.stringify(sortRequests)}`);
    }
  }

  await page.click("#reset");
  await page.waitForFunction(() =>
    document.querySelector('th[data-sort="category"]')?.getAttribute("aria-sort") === "none" &&
    document.querySelector("#pageJump")?.value === "1" &&
    document.querySelectorAll("#rows tr").length >= 80
  );

  const targetPage = Math.min(12, Math.ceil(selectedDateSummary.rows / 80));
  const expectedStart = ((targetPage - 1) * 80) + 1;
  const expectedEnd = Math.min(targetPage * 80, selectedDateSummary.rows);
  await page.fill("#pageJump", String(targetPage));
  await page.click("#jumpPage");
  await page.waitForFunction(({ pageValue, rangeText }) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return document.querySelector("#pageJump")?.value === pageValue && resultCount.includes(rangeText);
  }, {
    pageValue: String(targetPage),
    rangeText: `${formatNumber(expectedStart)}-${formatNumber(expectedEnd)}`,
  });

  let releaseDelayedFirstPage;
  const delayedFirstPage = new Promise((resolve) => {
    releaseDelayedFirstPage = resolve;
  });
  let delayedOnce = false;
  await page.route("**/api/trends?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      !delayedOnce &&
      url.searchParams.get("unique") === "yes" &&
      url.searchParams.get("offset") === "0"
    ) {
      delayedOnce = true;
      await delayedFirstPage;
    }
    await route.continue();
  });

  await page.selectOption("#queryMode", "unique");
  await page.waitForFunction(() => {
    return document.querySelector("#status")?.textContent?.includes("读取中");
  });

  const raceTargetPage = Math.min(21, Math.ceil(uniqueResult.total / 80));
  if (raceTargetPage < 2) {
    throw new Error(`expected enough unique rows for jump race test, got ${uniqueResult.total}`);
  }
  const raceExpectedStart = ((raceTargetPage - 1) * 80) + 1;
  const raceExpectedEnd = Math.min(raceTargetPage * 80, uniqueResult.total);
  await page.fill("#pageJump", String(raceTargetPage));
  await page.click("#jumpPage");
  releaseDelayedFirstPage();
  await page.waitForFunction(({ pageValue, rangeText }) => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return document.querySelector("#pageJump")?.value === pageValue && resultCount.includes(rangeText);
  }, {
    pageValue: String(raceTargetPage),
    rangeText: `${raceExpectedStart}-${raceExpectedEnd}`,
  });
} finally {
  await browser.close();
}
