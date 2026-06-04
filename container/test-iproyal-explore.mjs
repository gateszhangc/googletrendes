import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { Buffer } from 'node:buffer';

const proxyServer = process.env.IPROYAL_PROXY_SERVER || 'http://geo.iproyal.com:12321';
const proxyUser = process.env.IPROYAL_PROXY_USER;
const proxyPass = process.env.IPROYAL_PROXY_PASS;
const chainVia = process.env.CHAIN_VIA_PROXY;
const chainPort = Number(process.env.CHAIN_PROXY_PORT || 18080);
const geo = process.env.GOOGLE_TRENDS_GEO || 'US';
const hl = process.env.GOOGLE_TRENDS_HL || 'en-US';
const cat = process.env.GOOGLE_TRENDS_CAT || '533';

if (!proxyUser || !proxyPass) {
  console.error('Missing IPROYAL_PROXY_USER or IPROYAL_PROXY_PASS');
  process.exit(2);
}

function parseProxyUrl(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
}

function readHttpHeader(socket, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buffer = initial;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for proxy response'));
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker !== -1) {
        cleanup();
        resolve({
          header: buffer.slice(0, marker + 4).toString('latin1'),
          rest: buffer.slice(marker + 4),
        });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('Proxy closed connection before response header'));
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    if (buffer.length) onData(Buffer.alloc(0));
  });
}

async function connectTunnel({ upstreamProxy, iproyalProxy, target }) {
  const upstream = parseProxyUrl(upstreamProxy);
  const iproyal = parseProxyUrl(iproyalProxy);
  const socket = net.connect(upstream.port, upstream.host);

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    `CONNECT ${iproyal.host}:${iproyal.port} HTTP/1.1\r\n` +
      `Host: ${iproyal.host}:${iproyal.port}\r\n` +
      'Proxy-Connection: Keep-Alive\r\n\r\n',
  );
  const first = await readHttpHeader(socket);
  if (!/^HTTP\/1\.[01] 200\b/.test(first.header)) {
    throw new Error(`Outer proxy CONNECT failed: ${first.header.split('\r\n')[0]}`);
  }

  const auth = Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64');
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\n` +
      `Host: ${target}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      'Proxy-Connection: Keep-Alive\r\n\r\n',
  );
  const second = await readHttpHeader(socket, first.rest);
  if (!/^HTTP\/1\.[01] 200\b/.test(second.header)) {
    throw new Error(`IPRoyal CONNECT failed: ${second.header.split('\r\n')[0]}`);
  }

  return { socket, rest: second.rest };
}

function startChainedProxy() {
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end('CONNECT only\n');
  });

  server.on('connect', async (req, clientSocket, head) => {
    try {
      const tunnel = await connectTunnel({
        upstreamProxy: chainVia,
        iproyalProxy: proxyServer,
        target: req.url,
      });
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.socket.write(head);
      if (tunnel.rest.length) clientSocket.write(tunnel.rest);
      tunnel.socket.pipe(clientSocket);
      clientSocket.pipe(tunnel.socket);
    } catch (error) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      console.error(JSON.stringify({ step: 'chain_error', target: req.url, error: error.message }));
    }
  });

  return new Promise((resolve) => {
    server.listen(chainPort, '127.0.0.1', () => resolve(server));
  });
}

const chainedProxy = chainVia ? await startChainedProxy() : null;
const browserProxy = chainVia
  ? { server: `http://127.0.0.1:${chainPort}` }
  : { server: proxyServer, username: proxyUser, password: proxyPass };
if (chainVia) {
  console.log(JSON.stringify({ step: 'chain', listen: `127.0.0.1:${chainPort}`, via: chainVia }));
}

const browser = await chromium.launch({
  headless: true,
  proxy: browserProxy,
});

const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
page.setDefaultTimeout(60000);

const ipResp = await page.goto('https://ipv4.icanhazip.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
const ip = (await page.textContent('body')).trim();
console.log(JSON.stringify({ step: 'ip', status: ipResp?.status(), ip }));

const url = `https://trends.google.com/trends/explore?cat=${cat}&date=now%207-d&geo=${geo}&hl=${hl}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(45000);

const result = await page.evaluate(() => {
  const txt = (e) => (e?.innerText || e?.textContent || '').trim();
  const body = txt(document.body);
  const widgets = [...document.querySelectorAll('.fe-related-queries')].map((el) => txt(el).slice(0, 1500));
  return {
    url: location.href,
    title: document.title,
    relatedCount: widgets.length,
    is429: /429|Too Many Requests|unusual traffic/i.test(body),
    isPageError: /Oops|Try again|Ops\. Ocorreu|Tente novamente|出了点问题|稍后重试/i.test(body),
    body: body.slice(0, 1500),
    widgets,
  };
});
console.log(JSON.stringify({ step: 'explore', ...result }, null, 2));
await browser.close();
await new Promise((resolve) => chainedProxy?.close(resolve) ?? resolve());
