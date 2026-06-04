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

  await page.fill("#search", "台風");
  await page.waitForFunction(() => {
    const rows = document.querySelector("#rows")?.textContent || "";
    return rows.includes("台風");
  });

  const rowText = await page.locator("#rows tr").first().innerText();
  if (!rowText.includes("台風")) {
    throw new Error(`filtered row did not contain query: ${rowText}`);
  }
} finally {
  await browser.close();
}
