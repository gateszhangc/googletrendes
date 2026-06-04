import { chromium } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:9876";

const browser = await chromium.launch();
const page = await browser.newPage();

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
  if (!resultCount || !resultCount.includes("4,982")) {
    throw new Error(`default view should be latest date only, got: ${resultCount}`);
  }

  await page.fill("#search", "台風");
  await page.waitForFunction(() => {
    const rows = document.querySelector("#rows")?.textContent || "";
    return rows.includes("台風");
  });

  const rowText = await page.locator("#rows tr").first().innerText();
  if (!rowText.includes("台風")) {
    throw new Error(`filtered row did not contain query: ${rowText}`);
  }

  await page.fill("#search", "");
  await page.waitForFunction(() => {
    const resultCount = document.querySelector("#resultCount")?.textContent || "";
    return resultCount.includes("4,982");
  });

  const initialRows = await page.locator("#rows tr").count();
  await page.locator(".table-wrap").hover();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(300);
    if (await page.inputValue("#pageJump") === "2") break;
  }
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
