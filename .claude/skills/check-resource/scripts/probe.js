#!/usr/bin/env node
// Render a URL in headless Chromium and record the evidence needed to judge it
// against CONTRIBUTING.md: what loads, what fails, what the page says, and
// whether there are signs of paywalls or sign-up walls.
//
// Usage: node probe.js <url> <outdir>
// Writes <outdir>/probe.json and <outdir>/page.png, prints a short summary.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const [url, outdir] = process.argv.slice(2);
if (!url || !outdir) {
  console.error('usage: node probe.js <url> <outdir>');
  process.exit(2);
}
fs.mkdirSync(outdir, { recursive: true });

const PAYWALL_PATTERNS = [
  /\bsubscribe\b/i, /\bsubscription\b/i, /\bpricing\b/i, /\bbuy now\b/i,
  /\bcheckout\b/i, /\bfree trial\b/i, /\bpremium\b/i, /\bupgrade\b/i,
  /\bper month\b/i, /\/mo\b/i, /[$€£]\s?\d/, /\bsign up\b/i, /\blog ?in\b/i,
  /\bsign in\b/i, /\bregister\b/i, /\bmembers only\b/i,
];
const PLACEHOLDER_PATTERNS = [
  /coming soon/i, /under construction/i, /lorem ipsum/i, /work in progress/i,
  /domain (is )?for sale/i, /buy this domain/i, /parked/i,
];

function hostOf(u) {
  try { return new URL(u).host; } catch { return null; }
}

// In a sandboxed environment an egress proxy may refuse hosts the site itself
// serves fine. Ask the proxy which hosts it rejected so the report can tell
// "site broken" apart from "checker could not reach it".
function proxyRejectedHosts() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return new Set();
  try {
    const out = execFileSync('curl', ['-sS', '--max-time', '5', `${proxy}/__agentproxy/status`], { encoding: 'utf8' });
    const status = JSON.parse(out);
    return new Set((status.recentRelayFailures || [])
      .filter(f => f.kind === 'connect_rejected' && f.host)
      .map(f => f.host.replace(/:443$/, '')));
  } catch {
    return new Set();
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const responses = [];
  const failures = [];
  const consoleErrors = [];
  page.on('response', r => {
    const type = r.request().resourceType();
    if (['document', 'xhr', 'fetch', 'media', 'script'].includes(type) || r.status() >= 400) {
      responses.push({ url: r.url(), status: r.status(), type, contentType: r.headers()['content-type'] || '' });
    }
  });
  page.on('requestfailed', r => failures.push({ url: r.url(), type: r.resourceType(), error: r.failure()?.errorText }));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 300)));

  let navError = null;
  let mainStatus = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    mainStatus = resp ? resp.status() : null;
  } catch (e) {
    navError = e.message.split('\n')[0];
    // networkidle can time out on pages with long-polling; keep what loaded.
  }
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+\n/g, '\n').trim();
    const abs = a => { try { return new URL(a.getAttribute('href'), location.href).href; } catch { return null; } };
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ text: a.innerText.trim().slice(0, 80), href: abs(a) }))
      .filter(l => l.href && /^https?:/.test(l.href));
    return {
      finalUrl: location.href,
      title: document.title,
      lang: document.documentElement.lang || null,
      dir: document.documentElement.dir || document.body?.dir || null,
      metaDescription: document.querySelector('meta[name="description"]')?.content || null,
      headings: [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.trim()).filter(Boolean).slice(0, 40),
      textLength: text.length,
      textExcerpt: text.slice(0, 4000),
      counts: {
        video: document.querySelectorAll('video').length,
        iframe: document.querySelectorAll('iframe').length,
        img: document.querySelectorAll('img').length,
        links: links.length,
        inputs: document.querySelectorAll('input:not([type=hidden])').length,
        passwordInputs: document.querySelectorAll('input[type=password]').length,
      },
      iframes: [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean).slice(0, 20),
      links: links.slice(0, 150),
    };
  }).catch(e => ({ evaluateError: e.message }));

  await page.screenshot({ path: path.join(outdir, 'page.png'), fullPage: false }).catch(() => {});
  await browser.close();

  const text = info.textExcerpt || '';
  const hits = (patterns) => patterns.flatMap(re => {
    const m = text.match(re);
    if (!m) return [];
    const i = m.index;
    return [{ pattern: String(re), context: text.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ') }];
  });

  const rejected = proxyRejectedHosts();
  const failedHosts = {};
  for (const f of failures) {
    const h = hostOf(f.url);
    if (!h) continue;
    failedHosts[h] ??= { count: 0, sandboxBlocked: rejected.has(h), examples: [] };
    failedHosts[h].count++;
    if (failedHosts[h].examples.length < 3) failedHosts[h].examples.push(`${f.type} ${f.error} ${f.url}`);
  }

  const report = {
    requestedUrl: url,
    probedAt: new Date().toISOString(),
    mainStatus,
    navError,
    ...info,
    dataAndMediaRequests: responses.filter(r => ['xhr', 'fetch', 'media'].includes(r.type)).slice(0, 60),
    httpErrors: responses.filter(r => r.status >= 400).slice(0, 60),
    failedHosts,
    consoleErrors: consoleErrors.slice(0, 30),
    paywallOrSignupHints: hits(PAYWALL_PATTERNS),
    placeholderHints: hits(PLACEHOLDER_PATTERNS),
  };
  fs.writeFileSync(path.join(outdir, 'probe.json'), JSON.stringify(report, null, 2));

  const mainHost = hostOf(url);
  if (mainStatus === null && mainHost && failedHosts[mainHost]?.sandboxBlocked) {
    console.log(`!! The page itself is blocked by the sandbox proxy (${mainHost}). Nothing about the site could be verified.`);
  }
  console.log(`URL:          ${url} -> ${report.finalUrl || '?'}`);
  console.log(`Status:       ${mainStatus ?? 'none'}${navError ? `  (nav: ${navError})` : ''}`);
  console.log(`Title:        ${report.title || ''}`);
  console.log(`Lang/dir:     ${report.lang || '?'} / ${report.dir || '?'}`);
  console.log(`Text length:  ${report.textLength ?? '?'}  counts: ${JSON.stringify(report.counts || {})}`);
  console.log(`Data/media:   ${report.dataAndMediaRequests.length} requests, HTTP errors: ${report.httpErrors.length}`);
  for (const [h, v] of Object.entries(failedHosts)) {
    console.log(`Failed host:  ${h} x${v.count}${v.sandboxBlocked ? '  [BLOCKED BY SANDBOX PROXY - not the site\'s fault]' : ''}`);
  }
  console.log(`Paywall/signup hints: ${report.paywallOrSignupHints.length}, placeholder hints: ${report.placeholderHints.length}`);
  console.log(`Wrote ${path.join(outdir, 'probe.json')} and page.png`);
})().catch(e => { console.error(e); process.exit(1); });
