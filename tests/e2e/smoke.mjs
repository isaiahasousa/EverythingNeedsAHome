// End-to-end check of the built app in Chromium. Run `npm run build` first, then `npm run e2e`.
// Serves dist/ itself, drives every box type and the graphics + export flows, re-verifies the
// downloaded files, and exits non-zero if anything fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { verifyDownloads } from '../verify-downloads.mjs';

const failures = [];
function check(ok, label) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`);
  if (!ok) failures.push(label);
}

// ------------------------------------------------------------- fixtures

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(rgba(x, y), y * (1 + w * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enah-e2e-'));
const downloads = path.join(tmp, 'downloads');
fs.mkdirSync(downloads);
const logoPng = path.join(tmp, 'logo.png');
fs.writeFileSync(
  logoPng,
  png(240, 160, (x, y) => {
    const r = Math.hypot(x - 120, y - 80);
    const on = (r < 70 && r > 52) || (Math.abs(x - 120) < 8 && y > 30 && y < 130);
    return on ? [20, 20, 20, 255] : [255, 255, 255, 0];
  }),
);
const photoPng = path.join(tmp, 'photo.png');
fs.writeFileSync(
  photoPng,
  png(160, 120, (x, y) => {
    const v = Math.round(127 + 120 * Math.sin(x / 14) * Math.cos(y / 11));
    return [v, v, v, 255];
  }),
);
// Plain white: nothing to trace at any threshold until it is inverted.
const blankPng = path.join(tmp, 'blank.png');
fs.writeFileSync(blankPng, png(64, 48, () => [255, 255, 255, 255]));
const iconSvg = path.join(tmp, 'icon.svg');
fs.writeFileSync(
  iconSvg,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M50 5 95 50 50 95 5 50Z M50 30 70 50 50 70 30 50Z"/><path d="M10 90 90 10" stroke="#000" stroke-width="6" fill="none"/></svg>',
);

// ------------------------------------------------------------- run

if (!fs.existsSync('dist/index.html')) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(2);
}
const server = await preview({ preview: { port: 4179, strictPort: false, open: false }, logLevel: 'silent' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const consoleErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

  const status = () => page.textContent('.status-chip');
  const settleOn = async (pg) => {
    await pg.waitForTimeout(200);
    await pg.waitForFunction(
      () => {
        const chip = document.querySelector('.status-chip');
        return !!chip && /triangles/.test(chip.textContent || '') && !chip.classList.contains('busy');
      },
      null,
      { timeout: 60000 },
    );
    await pg.waitForTimeout(300);
  };
  const settle = () => settleOn(page);
  const step = (n, pg = page) => pg.click(`.stepper button:nth-child(${n})`);
  // Resolves once an autosave that went to IndexedDB after `after` (ms since epoch) has landed.
  const savedToIndexedDb = (pg, after) =>
    pg
      .waitForFunction(
        (t) => {
          try {
            return (JSON.parse(localStorage.getItem('everythingneedsahome.project.v1') || '{}').savedAt ?? 0) > t;
          } catch {
            return false;
          }
        },
        after,
        { timeout: 15000 },
      )
      .then(() => true, () => false);

  console.log(`App at ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await settle();
  check(/triangles/.test(await status()), 'geometry engine starts and builds the example box');

  console.log('Box types');
  const names = await page.$$eval('.type-card strong', (els) => els.map((e) => e.textContent));
  check(names.length === 8, `8 box types listed (${names.length})`);
  for (let i = 0; i < names.length; i++) {
    await page.click(`.type-card:nth-child(${i + 1})`);
    await settle();
    const s = await status();
    const err = await page.$('.stage-error');
    check(/triangles/.test(s) && !err, `${names[i]} builds (${s.trim()})`);
    for (const view of [2, 3]) {
      await page.click(`.view-modes button:nth-child(${view})`);
      await page.waitForTimeout(150);
    }
    await page.click('.view-modes button:nth-child(1)');
  }

  console.log('Graphics');
  await page.click('.type-card:nth-child(2)');
  await settle();
  await step(4);
  // Opening the face editor re-frames the camera (up to ~0.9 s); click once the view is still.
  await page.waitForTimeout(1200);
  const canvas = await page.$('.viewport-canvas canvas');
  const cb = await canvas.boundingBox();
  await page.click('.chip:has-text("Lid top")');
  let picked = '';
  for (let attempt = 0; attempt < 4 && picked !== 'Front'; attempt++) {
    if (attempt) await page.waitForTimeout(600);
    await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.62);
    await page.waitForTimeout(400);
    picked = (await page.textContent('.fe-head h3')) ?? '';
  }
  check(picked === 'Front', `clicking the model selects the face under the cursor (${picked})`);
  const countOn = async (face) => Number((await page.textContent(`.chip:has-text("${face}") .count`).catch(() => '0')) || 0);
  /** Waits (up to 15 s) for the graphics count on a face chip to reach `n`; returns the count seen last. */
  const countReaches = async (face, n) => {
    await page
      .waitForFunction(([f, want]) => [...document.querySelectorAll('.chip')].some((c) => c.textContent.includes(f) && Number(c.querySelector('.count')?.textContent || 0) === want), [face, n], { timeout: 15000 })
      .catch(() => {});
    return countOn(face);
  };
  /** Waits (up to 10 s) for the selected graphic's width / height to come close to `ratio`; returns the last ratio. */
  const ratioReaches = async (ratio) => {
    const read = () => page.$$eval('.inspector .pair .field input', (els) => els.slice(0, 2).map((e) => Number(e.value))).then(([w, h]) => w / h);
    await page
      .waitForFunction((r) => {
        const [w, h] = [...document.querySelectorAll('.inspector .pair .field input')].slice(0, 2).map((e) => Number(e.value));
        return Math.abs(w / h - r) < 0.02;
      }, ratio, { timeout: 10000 })
      .catch(() => {});
    return read();
  };
  const before = await countOn('Front');
  await page.click('.add-grid button:has-text("Text")');
  await page.fill('#graphic-text', 'M3 BOLTS');
  await page.click('.font-list button:has-text("Bebas Neue")');
  await page.click('.mode-grid button:has-text("Raised")');
  await settle();
  check((await countOn('Front')) === before + 1, 'text added to the front');
  await page.type('#graphic-text', 'XY', { delay: 60 });
  await settle();
  await page.click('.step-title');
  await page.keyboard.press('Control+z');
  check((await page.inputValue('#graphic-text')) === 'M3 BOLTS', 'one undo takes back a burst of typing');
  await settle();
  const sel = await page.$('.fe-sel');
  const sb = await sel.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 30, sb.y + sb.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await settle();
  const y = Number(await page.inputValue('.inspector .pair .field:nth-child(4) input'));
  check(y < -1, `dragging moves the graphic (y = ${y})`);
  await page.click('.chip:has-text("Right")');
  await page.setInputFiles('.add-grid + input[type=file]', logoPng);
  await settle();
  check((await countOn('Right')) >= 1, 'PNG traced onto the right side');
  const onRight = await countOn('Right');
  await page.setInputFiles('.add-grid + input[type=file]', blankPng);
  check((await countReaches('Right', onRight + 1)) === onRight + 1, 'an image with nothing to trace is still added');
  check(/nothing solid/i.test((await page.textContent('.toast').catch(() => '')) || ''), 'and the app says how to make it traceable');
  await page.keyboard.press('Control+z');
  await settle();
  // The logo traces to a square outline on a 3:2 picture: lithophane and back must keep each shape.
  await page.click('.chip:has-text("Right")');
  await page.click('.glist .gitem >> nth=0');
  const traced = await ratioReaches(1);
  await page.click('.mode-grid button:has-text("Lithophane")');
  const photo = await ratioReaches(1.5);
  await page.click('.mode-grid button:has-text("Engraved")');
  const back = await ratioReaches(traced);
  check(Math.abs(photo - 1.5) < 0.02 && Math.abs(back - traced) < 0.02, `switching to lithophane and back keeps proportions (${traced.toFixed(2)} → ${photo.toFixed(2)} → ${back.toFixed(2)})`);
  await settle();
  await page.click('.chip:has-text("Back")');
  await page.setInputFiles('.add-grid + input[type=file]', iconSvg);
  await page.click('.mode-grid button:has-text("Cut out")');
  await settle();
  check((await countOn('Back')) >= 1, 'SVG cut through the back');
  await page.click('.chip:has-text("Lid top")');
  await page.setInputFiles('.add-grid + input[type=file]', photoPng);
  await page.click('.mode-grid button:has-text("Lithophane")');
  await settle();
  check(!(await page.$('.stage-error')), 'lithophane builds');

  console.log('Exports');
  await step(5);
  await settle();
  const grab = async (selector, label) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(selector)]);
    const file = path.join(downloads, dl.suggestedFilename());
    await dl.saveAs(file);
    check(fs.statSync(file).size > 0, `${label} downloads (${dl.suggestedFilename()})`);
  };
  await grab('button:has-text("All parts, ready to slice")', '3MF');
  await grab('button:has-text("Every part as STL")', 'STL zip');
  await grab('button:has-text("Save project")', 'project file');
  await grab('.part-row:first-child button', 'single STL');
  // A download must never hand out a model that no longer matches the settings.
  await page.keyboard.press('Control+z');
  const gated = await page
    .waitForFunction(() => [...document.querySelectorAll('.big-actions button, .part-row button')].every((b) => b.disabled), null, { polling: 'raf', timeout: 5000 })
    .then(() => true, () => false);
  check(gated, 'downloads switch off while the model is rebuilding');
  await settle();
  check(await page.$$eval('.big-actions button, .part-row button', (bs) => bs.length > 0 && bs.every((b) => !b.disabled)), 'downloads switch back on when the rebuild is done');
  await page.keyboard.press('Control+Shift+z');
  await settle();
  const problems = await verifyDownloads(downloads, () => {});
  check(problems.length === 0, `downloaded meshes are watertight and on the bed${problems.length ? ': ' + problems.join('; ') : ''}`);

  console.log('Editing');
  await step(2);
  await page.fill('#param-width', '100+20');
  await page.press('#param-width', 'Enter');
  check((await page.inputValue('#param-width')) === '120', 'arithmetic in number fields');
  // Leave the field so the shortcut reaches the app instead of the field's own text undo.
  await page.click('.step-title');
  await page.keyboard.press('Control+z');
  check((await page.inputValue('#param-width')) === '90', 'undo');
  await page.keyboard.press('Control+Shift+z');
  check((await page.inputValue('#param-width')) === '120', 'redo');
  // Arrow keys step from what was just typed.
  await page.fill('#param-depth', '70');
  await page.keyboard.press('ArrowUp');
  check((await page.inputValue('#param-depth')) === '71', 'arrow keys step from the typed value');
  await page.click('.step-title');
  await page.keyboard.press('Control+z');
  check((await page.inputValue('#param-depth')) === '64', 'and one undo takes the nudge back');
  await page.click('.segmented button:has-text("Inches")');
  check((await page.inputValue('#param-width')) === '4.724', 'inch display');
  // Tabbing through fields without typing must not store the rounded inch values.
  await page.focus('#param-width');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  await page.click('.segmented button:has-text("Millimetres")');
  check((await page.inputValue('#param-width')) === '120' && (await page.inputValue('#param-depth')) === '64', 'leaving inch fields untouched keeps the millimetres');
  await step(3);
  await page.fill('#param-lidHeight', '60');
  await page.press('#param-lidHeight', 'Enter');
  await page.waitForTimeout(1200);
  check(/taller than the box/i.test((await page.textContent('.stage-error').catch(() => '')) || ''), 'impossible settings explain themselves');
  await page.keyboard.press('Control+z');
  await settle();
  await page.reload({ waitUntil: 'networkidle' });
  await settle();
  await step(2);
  check((await page.inputValue('#param-width')) === '120', 'autosave survives a reload');
  // An edit made just before closing or reloading is saved too.
  await page.fill('#param-width', '125');
  await page.press('#param-width', 'Enter');
  await page.waitForTimeout(80);
  await page.reload({ waitUntil: 'networkidle' });
  await settle();
  await step(2);
  check((await page.inputValue('#param-width')) === '125', 'an edit made right before a reload is kept');
  await page.fill('#param-width', '120');
  await page.press('#param-width', 'Enter');

  console.log('Autosave beyond the localStorage quota');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Simulate a project too big for localStorage: the full save throws, a tiny marker fits.
    await ctx.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'everythingneedsahome.project.v1' && String(v).length > 1000) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return setItem.call(this, k, v);
      };
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => consoleErrors.push(e.message));
    pg.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    await pg.goto(url, { waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(2, pg);
    let t0 = await pg.evaluate(() => Date.now());
    await pg.fill('#param-width', '133');
    await pg.press('#param-width', 'Enter');
    check(await savedToIndexedDb(pg, t0), 'a project too big for localStorage is autosaved to IndexedDB');
    check(!/autosave/i.test((await pg.textContent('.toast').catch(() => '')) || ''), 'no autosave warning when IndexedDB takes the project');
    await pg.reload({ waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(2, pg);
    await pg.waitForFunction(() => document.querySelector('#param-width')?.value === '133', null, { timeout: 5000 }).catch(() => {});
    check((await pg.inputValue('#param-width')) === '133', 'a project too big for localStorage survives a reload');
    // Site data cleared behind the app's back: the pointer remains but the copy is gone.
    await pg.evaluate(() => new Promise((resolve) => { const r = indexedDB.deleteDatabase('everythingneedsahome'); r.onsuccess = r.onerror = r.onblocked = resolve; }));
    await pg.reload({ waitUntil: 'domcontentloaded' });
    // The notice shows for a few seconds as the app opens; catch it then.
    const noticed = await pg.waitForSelector('.toast:has-text("no longer in this browser")', { timeout: 15000 }).then(() => true, () => false);
    check(noticed, 'a vanished autosave is reported, not hidden');
    await settleOn(pg);
    await step(2, pg);
    t0 = await pg.evaluate(() => Date.now());
    await pg.fill('#param-width', '144');
    await pg.press('#param-width', 'Enter');
    await savedToIndexedDb(pg, t0);
    await pg.reload({ waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(2, pg);
    await pg.waitForFunction(() => document.querySelector('#param-width')?.value === '144', null, { timeout: 5000 }).catch(() => {});
    check((await pg.inputValue('#param-width')) === '144', 'and autosave keeps working afterwards');
    // An edit right before a reload, or before closing the tab, is saved even though it goes to IndexedDB.
    await pg.fill('#param-width', '155');
    await pg.press('#param-width', 'Enter');
    await pg.reload({ waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(2, pg);
    await pg.waitForFunction(() => document.querySelector('#param-width')?.value === '155', null, { timeout: 5000 }).catch(() => {});
    check((await pg.inputValue('#param-width')) === '155', 'a large project keeps an edit made right before a reload');
    await pg.fill('#param-width', '166');
    await pg.press('#param-width', 'Enter');
    await pg.close();
    const again = await ctx.newPage();
    again.on('pageerror', (e) => consoleErrors.push(e.message));
    await again.goto(url, { waitUntil: 'networkidle' });
    await settleOn(again);
    await step(2, again);
    await again.waitForFunction(() => document.querySelector('#param-width')?.value === '166', null, { timeout: 5000 }).catch(() => {});
    check((await again.inputValue('#param-width')) === '166', 'and one made right before the tab is closed');
    // An undo saves at once, without the usual pause: closing straight after it keeps it too.
    await again.fill('#param-width', '177');
    await again.press('#param-width', 'Enter');
    const t1 = await again.evaluate(() => Date.now());
    await savedToIndexedDb(again, t1);
    await again.click('.step-title');
    await again.keyboard.press('Control+z');
    await again.close();
    const third = await ctx.newPage();
    third.on('pageerror', (e) => consoleErrors.push(e.message));
    await third.goto(url, { waitUntil: 'networkidle' });
    await settleOn(third);
    await step(2, third);
    await third.waitForFunction(() => document.querySelector('#param-width')?.value === '166', null, { timeout: 5000 }).catch(() => {});
    check((await third.inputValue('#param-width')) === '166', 'an undo right before the tab is closed is kept');
    await ctx.close();
  }

  console.log('Autosave of a genuinely large project');
  {
    // Photos big enough that each save takes a noticeable time, so a reload can land while one is under way.
    const first = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const maker = await first.newPage();
    await maker.goto(url, { waitUntil: 'networkidle' });
    await settleOn(maker);
    await step(2, maker);
    await maker.fill('#param-width', '120');
    await maker.press('#param-width', 'Enter');
    await maker.waitForTimeout(800);
    const project = await maker.evaluate(() => JSON.parse(localStorage.getItem('everythingneedsahome.project.v1')));
    await first.close();
    const noise = `data:image/png;base64,${png(1100, 1100, () => [Math.random() * 256, Math.random() * 256, Math.random() * 256, 255]).toString('base64')}`;
    // A fresh page, left untouched while the project is saved behind it (as another tab would).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => consoleErrors.push(e.message));
    pg.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    await pg.goto(url, { waitUntil: 'networkidle' });
    await settleOn(pg);
    project.graphics.push(
      ...[0, 1].map((i) => ({
        ...project.graphics[0],
        id: `photo${i}`,
        source: { kind: 'image', name: `photo${i}`, dataUrl: noise, threshold: 128, invert: false, detail: 3 },
        mode: 'lithophane',
        hidden: true,
      })),
    );
    // Seed it the way an earlier visit would have left it: the project in IndexedDB, a pointer in localStorage.
    await pg.evaluate(async (json) => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('everythingneedsahome', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('autosave');
        req.onsuccess = () => {
          const tx = req.result.transaction('autosave', 'readwrite');
          tx.objectStore('autosave').put(json, 'everythingneedsahome.project.v1');
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      localStorage.setItem('everythingneedsahome.project.v1', JSON.stringify({ storedIn: 'indexeddb', savedAt: 1 }));
    }, JSON.stringify(project));
    const reopen = async (how, p) => {
      if (how === 'reload') await p.reload({ waitUntil: 'networkidle' });
      else {
        await p.close();
        p = await ctx.newPage();
        p.on('pageerror', (e) => consoleErrors.push(e.message));
        await p.goto(url, { waitUntil: 'networkidle' });
      }
      await settleOn(p);
      await step(2, p);
      return p;
    };
    let big = await reopen('reload', pg);
    check((await big.inputValue('#param-width')) === '120', 'a large project opens from IndexedDB, and a page left untouched never writes over it');
    // The usual autosave starts 400 ms after an edit; 450 ms later it is still writing this project.
    for (const [how, width] of [['reload', '131'], ['close', '132']]) {
      await big.fill('#param-width', width);
      await big.press('#param-width', 'Enter');
      await big.waitForTimeout(450);
      big = await reopen(how, big);
      await big.waitForFunction((w) => document.querySelector('#param-width')?.value === w, width, { timeout: 5000 }).catch(() => {});
      check((await big.inputValue('#param-width')) === width, `an edit is kept when a ${how} lands while a large save is under way`);
    }
    await ctx.close();
  }

  console.log('Uploaded fonts');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => consoleErrors.push(e.message));
    pg.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    const outline = () =>
      pg.evaluate(() => [...document.querySelectorAll('.fe-canvas g[clip-path] > g')].map((g) => g.querySelector('g[transform^="matrix"] path')?.getAttribute('d') ?? '').join('|'));
    await pg.goto(url, { waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(4, pg);
    await pg.waitForTimeout(300);
    await pg.click('.chip:has-text("Right")');
    await pg.click('.add-grid button:has-text("Text")');
    await pg.fill('#graphic-text', 'Hg');
    await settleOn(pg);
    const builtIn = await outline();
    await pg.setInputFiles('input[type=file][accept*=".ttf"]', 'public/fonts/pacifico.woff');
    await settleOn(pg);
    const uploaded = await outline();
    check(uploaded.length > 0 && uploaded !== builtIn, 'an uploaded font changes the text outline');
    await pg.waitForTimeout(1200);
    await pg.reload({ waitUntil: 'networkidle' });
    await settleOn(pg);
    await step(4, pg);
    await pg.waitForTimeout(300);
    await pg.click('.chip:has-text("Right")');
    await pg.click('.glist .gitem:has-text("Hg")');
    await settleOn(pg);
    await pg.waitForTimeout(500);
    check((await outline()) === uploaded, 'the uploaded font is still used after a reload');
    await ctx.close();
  }

  console.log('Layout and theme');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no sideways scrolling at phone width');
  await page.emulateMedia({ colorScheme: 'dark' });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  check(r + g + b < 150, `dark theme applies (${bg})`);
} finally {
  await browser.close();
  server.httpServer.close();
}

check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ':\n    ' + consoleErrors.slice(0, 5).join('\n    ') : ''}`);
console.log(failures.length ? `\nE2E FAILED (${failures.length}):\n- ${failures.join('\n- ')}` : '\nE2E PASSED');
process.exit(failures.length ? 1 : 0);
