// Open the desktop in an isolated Chromium window.
import { chromium } from 'playwright-core';
import type { App } from '../src/app.js';

export async function openDesktop(a: App, size = { width: 1440, height: 900 }) {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: size })).newPage();
  await page.goto(a.desktop.url);
  return {
    page,
    js: <T = unknown>(code: string) => page.evaluate(code) as Promise<T>,
    close: () => browser.close(),
  };
}
