import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const proxyServer = process.env.IPROYAL_PROXY_SERVER || 'https://geo.iproyal.com:12321';
const proxyUser = process.env.IPROYAL_PROXY_USER;
const proxyPass = process.env.IPROYAL_PROXY_PASS;
const outputDir = process.env.OUTPUT_DIR || '/work';
const geo = process.env.GOOGLE_TRENDS_GEO || 'BR';
const hl = process.env.GOOGLE_TRENDS_HL || 'pt-BR';
const tz = process.env.GOOGLE_TRENDS_TZ || '180';
const sleepMs = Number(process.env.GOOGLE_TRENDS_CATEGORY_SLEEP_MS || 180000);
const pageSize = Number(process.env.GOOGLE_TRENDS_PAGE_SIZE || 5);

const categories = [
  ['0', '所有类别'],
  ['3', '艺术与娱乐'],
  ['184', '汽车'],
  ['44', '美容与健身'],
  ['22', '书籍与文学'],
  ['12', '商业与工业'],
  ['5', '计算机与电子'],
  ['7', '金融'],
  ['71', '饮食'],
  ['8', '游戏'],
  ['45', '健康'],
  ['65', '爱好与休闲'],
  ['11', '家居与园艺'],
  ['13', '互联网与电信'],
  ['958', '求职与教育'],
  ['19', '法律与政府'],
  ['16', '新闻'],
  ['299', '在线社区'],
  ['14', '人物与社会'],
  ['66', '宠物与动物'],
  ['29', '房地产'],
  ['533', '体育'],
  ['174', '科学'],
  ['18', '购物'],
  ['67', '旅游与交通'],
];

if (!proxyUser || !proxyPass) {
  console.error('Missing IPROYAL_PROXY_USER or IPROYAL_PROXY_PASS');
  process.exit(2);
}

fs.mkdirSync(outputDir, { recursive: true });
const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const outTsv = path.join(outputDir, `google_trends_${geo}_rising_by_category_${runId}.tsv`);
const statusFile = path.join(outputDir, `google_trends_${geo}_rising_status.json`);
const logFile = path.join(outputDir, `google_trends_${geo}_rising_by_category_${runId}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
}

function writeStatus(status, nextAction, reason = '', extra = {}) {
  fs.writeFileSync(
    statusFile,
    JSON.stringify(
      {
        status,
        next_action: nextAction,
        reason,
        run_id: runId,
        geo,
        hl,
        output_file: outTsv,
        log_file: logFile,
        updated_at: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
  );
}

function stripPrefix(text) {
  return text.replace(/^\)\]\}',?\s*/, '');
}

async function readBody(page) {
  return ((await page.textContent('body').catch(() => '')) || '').trim();
}

function is429(status, body) {
  return status === 429 || /429|Too Many Requests|unusual traffic/i.test(body);
}

function buildExploreUrl(category) {
  const req = {
    comparisonItem: [{ geo, time: 'now 7-d' }],
    category: Number(category),
    property: '',
  };
  return (
    'https://trends.google.com/trends/api/explore?' +
    new URLSearchParams({ hl, tz, req: JSON.stringify(req) }).toString()
  );
}

function buildRelatedUrl(widget) {
  return (
    'https://trends.google.com/trends/api/widgetdata/relatedsearches?' +
    new URLSearchParams({
      hl,
      tz,
      req: JSON.stringify(widget.request),
      token: widget.token,
    }).toString()
  );
}

function risingRows(relatedData) {
  const rankedList = relatedData?.default?.rankedList || [];
  const rising = rankedList[1]?.rankedKeyword || [];
  return rising.map((item, index) => ({
    rank: index + 1,
    page: Math.floor(index / pageSize) + 1,
    query: item.query || item.topic?.title || '',
    change: item.formattedValue || item.value || 'BREAKOUT',
  }));
}

async function gotoJson(page, url, label, categoryName) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const body = await readBody(page);
  const status = response?.status() || 0;
  if (is429(status, body)) {
    const reason = `${label} 429 at ${categoryName}: ${body.slice(0, 220)}`;
    writeStatus('blocked_rate_limit', 'wait_and_retry', reason, {
      next_retry_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    throw Object.assign(new Error(reason), { code: 'RATE_LIMIT' });
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${label} HTTP ${status} at ${categoryName}: ${body.slice(0, 220)}`);
  }
  return JSON.parse(stripPrefix(body));
}

fs.writeFileSync(outTsv, 'category_id\tcategory\tpage\trank\tquery\tchange\n');
writeStatus('running', 'capture_in_progress');

const browser = await chromium.launch({
  headless: true,
  proxy: { server: proxyServer, username: proxyUser, password: proxyPass },
});
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: hl });
page.setDefaultTimeout(60000);

try {
  const ipResponse = await page.goto('https://ipv4.icanhazip.com', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const ip = await readBody(page);
  log(`Proxy IP status=${ipResponse?.status()} ip=${ip}`);

  for (const [categoryId, categoryName] of categories) {
    log(`Category start: ${categoryName} cat=${categoryId}`);
    const exploreData = await gotoJson(page, buildExploreUrl(categoryId), 'explore', categoryName);
    const widget = (exploreData.widgets || []).find((item) =>
      String(item.id || '').includes('RELATED_QUERIES'),
    );
    if (!widget) {
      log(`No RELATED_QUERIES widget: ${categoryName} cat=${categoryId}`);
      continue;
    }

    const relatedData = await gotoJson(page, buildRelatedUrl(widget), 'relatedsearches', categoryName);
    const rows = risingRows(relatedData);
    for (const row of rows) {
      fs.appendFileSync(
        outTsv,
        `${categoryId}\t${categoryName}\t${row.page}\t${row.rank}\t${row.query}\t${row.change}\n`,
      );
    }
    log(`Category done: ${categoryName} cat=${categoryId} rising_rows=${rows.length}`);
    if (sleepMs > 0) await page.waitForTimeout(sleepMs);
  }

  const rowCount = fs.readFileSync(outTsv, 'utf8').trim().split('\n').length - 1;
  writeStatus('complete', 'summarize_results', 'Capture complete', { rows: rowCount });
  log(`Capture complete rows=${rowCount} output=${outTsv}`);
} catch (error) {
  if (error.code !== 'RATE_LIMIT') {
    writeStatus('failed', 'inspect_log', error.message);
  }
  log(`Capture stopped: ${error.message}`);
  process.exitCode = error.code === 'RATE_LIMIT' ? 42 : 1;
} finally {
  await browser.close();
}
