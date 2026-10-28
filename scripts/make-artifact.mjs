// Turns the Vite build in dist/ into dist-artifact/: a page fragment for claude.ai artifact hosting
// (the host adds its own <html>/<head>/<body>), with the CSS inlined and every other asset kept
// as a relative file published alongside the page.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const out = path.resolve('dist-artifact');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true });
// Host config for Cloudflare Pages / Netlify; meaningless inside an artifact.
fs.rmSync(path.join(out, '_headers'), { force: true });

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const title = /<title>(.*?)<\/title>/s.exec(html)?.[1] ?? 'EverythingNeedsAHome';
const fontLinks = [...html.matchAll(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts\.[^>]+>/g)].map((m) => m[0]);
const script = /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/.exec(html)?.[1];
const cssHref = /<link rel="stylesheet"[^>]*href="(\.\/assets\/[^"]+\.css)"[^>]*>/.exec(html)?.[1];
if (!script || !cssHref) throw new Error('Unexpected dist/index.html layout');
const css = fs.readFileSync(path.join(dist, cssHref), 'utf8');
fs.rmSync(path.join(out, cssHref));

const page = [
  `<title>${title}</title>`,
  `<meta name="claude:viewport-fit-sides" content="cover">`,
  ...fontLinks,
  `<style>${css}</style>`,
  `<div id="root"></div>`,
  `<script type="module" src="${script}"></script>`,
  '',
].join('\n');
fs.writeFileSync(path.join(out, 'index.html'), page);

const files = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (path.relative(out, p) !== 'index.html') files.push(path.relative(out, p));
  }
};
walk(out);
fs.writeFileSync(path.join(out, 'files.json'), JSON.stringify(files, null, 2));
console.log(`dist-artifact/index.html (${page.length} bytes) + ${files.length} files:\n  ${files.join('\n  ')}`);
