import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDir = resolve('captures');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  devtools: true,
});
const context = await browser.newContext();
const page = await context.newPage();
const captured = [];
const keywords = /payment|billing|subscription|invoice|transaction|checkout|stripe|account|backend-api\/me|active_until|accounts\/check/i;

page.on('response', async (response) => {
  const url = response.url();
  if (!keywords.test(url)) return;

  const contentType = response.headers()['content-type'] || '';
  if (!/json/i.test(contentType)) return;

  try {
    const body = await response.json();
    const entry = {
      capturedAt: new Date().toISOString(),
      method: response.request().method(),
      url,
      status: response.status(),
      body,
    };
    captured.push(entry);
    await writeFile(resolve(outputDir, 'billing-responses.json'), JSON.stringify(captured, null, 2));
    console.log(`[capture] ${entry.method} ${entry.status} ${url}`);
  } catch {
    // Ignore non-JSON and unreadable responses.
  }
});

console.log('Playwright 浏览器已启动。请用付费账号登录，然后打开“设置 → 账户”。');
console.log('重点看 /backend-api/subscriptions?account_id= 的 active_until，以及 transaction-history 的 period_start。');
console.log(`匹配的 JSON 响应将保存到：${resolve(outputDir, 'billing-responses.json')}`);
await page.goto('https://chatgpt.com/#settings', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

await new Promise((resolveClose) => browser.on('disconnected', resolveClose));
