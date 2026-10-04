#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function parseArgs(argv) {
  const allowed = new Set(['input', 'output', 'prefix', 'playwright-module', 'browser-executable']);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Invalid argument: ${argv[i]}`);
    }
    options[key] = argv[i + 1];
  }
  if (!options.input || !options.output) throw new Error('Required arguments: --input HTML_FILE --output DIRECTORY');
  options.prefix = options.prefix || 'cards';
  if (!/^[a-zA-Z0-9_-]+$/.test(options.prefix)) throw new Error('Prefix must contain only letters, digits, underscores or hyphens');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  await fs.access(input);
  const { chromium } = require(options['playwright-module'] || 'playwright');
  const launchOptions = { headless: true };
  if (options['browser-executable']) launchOptions.executablePath = path.resolve(options['browser-executable']);
  let browser;
  const pending = [];
  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(input).href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.decode()));
    });
    const cards = page.locator('.card');
    const count = await cards.count();
    if (!count) throw new Error('No .card elements found');
    const reports = [];
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const report = await card.evaluate(element => {
        const root = element.getBoundingClientRect();
        const issues = [];
        const epsilon = 2;
        const outside = (child, parent) => child.left < parent.left - epsilon || child.right > parent.right + epsilon || child.top < parent.top - epsilon || child.bottom > parent.bottom + epsilon;
        if (element.scrollWidth > element.clientWidth + epsilon || element.scrollHeight > element.clientHeight + epsilon) issues.push('Card scroll overflow');
        for (const node of element.querySelectorAll('*')) {
          if (!(node instanceof HTMLElement) || !node.getClientRects().length) continue;
          if (outside(node.getBoundingClientRect(), root)) issues.push(`Outside card: ${node.tagName}.${node.className}`);
        }
        const blocks = Array.from(element.children).filter(node => node.getClientRects().length && !['STYLE', 'SCRIPT'].includes(node.tagName));
        for (let a = 0; a < blocks.length; a++) {
          for (let b = a + 1; b < blocks.length; b++) {
            const first = blocks[a].getBoundingClientRect();
            const second = blocks[b].getBoundingClientRect();
            if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > epsilon && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > epsilon) {
              issues.push(`Overlapping modules: ${blocks[a].classList.value} / ${blocks[b].classList.value}`);
            }
          }
        }
        for (const graphic of element.querySelectorAll('svg')) {
          const bounds = graphic.getBoundingClientRect();
          for (const label of graphic.querySelectorAll('text')) {
            if (outside(label.getBoundingClientRect(), bounds)) issues.push(`SVG text outside canvas: ${label.textContent}`);
          }
        }
        return { width: root.width, height: root.height, issues: Array.from(new Set(issues)) };
      });
      reports.push({ card: i + 1, ...report });
    }
    console.log(JSON.stringify(reports, null, 2));
    if (reports.some(report => report.issues.length)) throw new Error('Layout checks failed; fix HTML before exporting');
    await fs.mkdir(output, { recursive: true });
    const destinations = [];
    for (let i = 0; i < count; i++) {
      const destination = path.join(output, `${options.prefix}_${String(i + 1).padStart(2, '0')}.png`);
      try { await fs.access(destination); throw new Error(`Output exists: ${destination}; use a new directory or prefix`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      destinations.push(destination);
    }
    for (let i = 0; i < count; i++) {
      const temporary = `${destinations[i]}.pending.png`;
      pending.push(temporary);
      await cards.nth(i).screenshot({ path: temporary, animations: 'disabled' });
    }
    for (let i = 0; i < count; i++) await fs.rename(pending[i], destinations[i]);
    console.log(`Exported ${count} cards to ${output}`);
  } finally {
    if (browser) await browser.close();
    await Promise.all(pending.map(file => fs.rm(file, { force: true })));
  }
}
main().catch(error => { console.error(`Card export failed: ${error.stack || error.message}`); process.exitCode = 1; });
