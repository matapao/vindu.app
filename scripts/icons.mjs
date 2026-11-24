// The pages' icons as pictures, made from their drawings (SVG) in a Chromium (Playwright's), for what takes no drawing:
// Safari's Home Screen and Dock (apple-touch-icon, 180, full-bleed, as iOS adds its own corners), the web app
// manifest's sizes as drawn (192, 512), and its maskable ones (192, 512: full-bleed, the glyph a little smaller, so the
// shape a phone cuts it to leaves it whole); and vindu's own as the desktop app's (vindu-mac-1024.png: its square on 824
// of 1024 pixels, as a Mac's icons are). The icons are one family: a square of the app's colour, light at the top, with
// one white glyph in the middle. A drawing has its square as a rect with id="bg" and its glyph as a group with
// id="glyph": full-bleed is that square with no corners. Run again when a drawing changes:
//   node scripts/icons.mjs [drawing.svg …]     (static/icons/*.svg by default; each picture beside its drawing)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const HERE = import.meta.dirname;
const svgs = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(HERE, '..', 'static', 'icons')).filter(f => f.endsWith('.svg')).map(f => path.join(HERE, '..', 'static', 'icons', f));
/** The drawing with its square's corners taken off. */
const bleed = text => text.replace(/(<rect id="bg"[^>]*?)\srx="[\d.]+"/, '$1');
/** Full-bleed, the glyph at 84% about the middle: inside the circle every phone's shape keeps. */
const maskable = text => bleed(text).replace('<g id="glyph"', '<g id="glyph" transform="translate(256 256) scale(.84) translate(-256 -256)"');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**', r => (r.request().url().startsWith('data:') ? r.continue() : r.abort())); // the drawing alone
  const draw = async (text, size, at, canvas, out) => {
    const data = `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
    await page.setViewportSize({ width: canvas, height: canvas });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${data}" width="${size}" height="${size}" style="display:block;margin:${at}px"></body></html>`);
    await page.locator('img').evaluate(img => img.decode());
    fs.writeFileSync(out, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: canvas, height: canvas } }));
    console.log(path.relative(process.cwd(), out));
  };
  for (const svg of svgs) {
    const text = fs.readFileSync(svg, 'utf8'), named = n => svg.replace(/\.svg$/, `-${n}.png`);
    if (!/<rect id="bg"/.test(text) || !/<g id="glyph"/.test(text)) throw new Error(`${svg}: a drawing here has <rect id="bg"> and <g id="glyph">`);
    await draw(bleed(text), 180, 0, 180, named(180));
    for (const size of [192, 512]) await draw(text, size, 0, size, named(size));
    for (const size of [192, 512]) await draw(maskable(text), size, 0, size, named(`maskable-${size}`));
    if (path.basename(svg) === 'vindu.svg') await draw(text, 824, 100, 1024, named('mac-1024'));
  }
} finally { await browser.close(); }
