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

  await page.fill("#pageJump", "12");
  await page.click("#jumpPage");
  await page.waitForFunction(() => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return document.querySelector("#pageJump")?.value === "12" && resultCount.includes("881-960");
  });
} finally {
  await browser.close();
}
