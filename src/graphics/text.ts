import type { Font, PathCommand } from 'opentype.js';
import type { Shape2D, Vec2 } from '../core/types';
import { hashString } from '../core/hash';
import { EMPTY_SHAPE, makeShape } from './shape2d';

export interface FontInfo {
  id: string;
  label: string;
  file: string;
  /** CSS family used to preview the font in the picker (loaded from the same file). */
  css: string;
  note: string;
}

export const FONTS: FontInfo[] = [
  { id: 'archivo-black', label: 'Archivo Black', file: 'archivo-black.woff', css: 'BX Archivo Black', note: 'Heavy sans, great raised lettering' },
  { id: 'fredoka', label: 'Fredoka', file: 'fredoka-semibold.woff', css: 'BX Fredoka', note: 'Rounded and friendly' },
  { id: 'bebas-neue', label: 'Bebas Neue', file: 'bebas-neue.woff', css: 'BX Bebas Neue', note: 'Tall condensed capitals' },
  { id: 'roboto-slab', label: 'Roboto Slab', file: 'roboto-slab-bold.woff', css: 'BX Roboto Slab', note: 'Sturdy slab serif' },
  { id: 'allerta-stencil', label: 'Allerta Stencil', file: 'allerta-stencil.woff', css: 'BX Allerta Stencil', note: 'Stencil: letters stay whole when cut through' },
  { id: 'orbitron', label: 'Orbitron', file: 'orbitron-bold.woff', css: 'BX Orbitron', note: 'Geometric, technical' },
  { id: 'pacifico', label: 'Pacifico', file: 'pacifico.woff', css: 'BX Pacifico', note: 'Connected script' },
  { id: 'permanent-marker', label: 'Permanent Marker', file: 'permanent-marker.woff', css: 'BX Permanent Marker', note: 'Hand lettered' },
];

const fontCache = new Map<string, Promise<Font>>();
/** User fonts by id, parsed (or being parsed) from an upload or from the copy saved in the project. */
const customFonts = new Map<string, { font: Promise<Font>; fingerprint: string }>();
const fontListeners = new Set<(id: string) => void>();

/** A user font saved inside a project, so text keeps its font after a reload or on another computer. */
export interface SavedFont {
  id: string;
  name: string;
  /** The font file, base64. */
  data: string;
}

/** Runs `fn` with a font id whenever a user font arrives or changes, so cached outlines can be redone. */
export function onFontRegistered(fn: (id: string) => void) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

export function fontUrl(file: string) {
  return new URL(`fonts/${file}`, document.baseURI).href;
}

async function loadOpentype() {
  const mod = await import('opentype.js');
  return (mod as unknown as { default?: typeof import('opentype.js') }).default ?? mod;
}

export function loadFont(id: string): Promise<Font> {
  if (isCustomFont(id)) {
    // Never fall back to another font: the outline would silently change in the exported model.
    const custom = customFonts.get(id);
    return custom ? custom.font : Promise.reject(new Error(`The font “${customFontName(id)}” is not loaded. Upload it again with “Use my own font”.`));
  }
  let p = fontCache.get(id);
  if (!p) {
    const info = FONTS.find((f) => f.id === id) ?? FONTS[0];
    p = (async () => {
      const [ot, buf] = await Promise.all([loadOpentype(), fetch(fontUrl(info.file)).then((r) => {
        if (!r.ok) throw new Error(`Font ${info.label} failed to load (${r.status})`);
        return r.arrayBuffer();
      })]);
      return ot.parse(buf);
    })();
    fontCache.set(id, p);
    p.catch(() => fontCache.delete(id));
  }
  return p;
}

/** Identifies a font file by its whole contents. */
const fingerprint = (data: string) => hashString(data);

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

function setCustomFont(id: string, font: Promise<Font>, print: string) {
  customFonts.set(id, { font, fingerprint: print });
  font.then(
    () => fontListeners.forEach((l) => l(id)),
    () => {
      if (customFonts.get(id)?.font === font) customFonts.delete(id);
      fontListeners.forEach((l) => l(id));
    },
  );
}

/** Register a user-supplied TTF/OTF/WOFF. Returns its id and the file as base64, to save with the project. */
export async function registerCustomFont(buf: ArrayBuffer, name: string): Promise<SavedFont> {
  const ot = await loadOpentype();
  const font = ot.parse(buf); // throws for files opentype.js cannot read; nothing is registered then
  const data = bufferToBase64(buf);
  const print = fingerprint(data);
  // The id names the file's contents: another font uploaded under the same name gets its own id.
  const id = `custom:${name}#${print}`;
  setCustomFont(id, Promise.resolve(font), print);
  return { id, name, data };
}

/** The name a user font was uploaded as. */
export function customFontName(id: string) {
  return id.slice(7).replace(/#[^#]*$/, '');
}

let lastSaved: SavedFont[] | undefined;

/** Make the fonts saved in a project available. Parsing is asynchronous; text that uses them waits for it. */
export function registerSavedFonts(fonts: SavedFont[]) {
  if (fonts === lastSaved) return;
  lastSaved = fonts;
  for (const f of fonts) {
    const print = fingerprint(f.data);
    if (customFonts.get(f.id)?.fingerprint === print) continue;
    setCustomFont(f.id, loadOpentype().then((ot) => ot.parse(base64ToBuffer(f.data))), print);
  }
}

export function isCustomFont(id: string) {
  return id.startsWith('custom:');
}

/** Flatten opentype path commands (y down) into closed rings (y up). */
function commandsToRings(cmds: PathCommand[], tol: number): Vec2[][] {
  const rings: Vec2[][] = [];
  let ring: Vec2[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const push = (x: number, y: number) => ring.push([x, -y]);
  const steps = (len: number) => Math.max(2, Math.min(24, Math.ceil(len / tol)));
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        if (ring.length >= 3) rings.push(ring);
        ring = [];
        cx = sx = c.x;
        cy = sy = c.y;
        push(cx, cy);
        break;
      case 'L':
        cx = c.x;
        cy = c.y;
        push(cx, cy);
        break;
      case 'Q': {
        const n = steps(Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x - c.x1, c.y - c.y1));
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          push(mt * mt * cx + 2 * mt * t * c.x1 + t * t * c.x, mt * mt * cy + 2 * mt * t * c.y1 + t * t * c.y);
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'C': {
        const n = steps(Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
          push(a * cx + b * c.x1 + d * c.x2 + e * c.x, a * cy + b * c.y1 + d * c.y2 + e * c.y);
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        if (ring.length >= 3) rings.push(ring);
        ring = [];
        cx = sx;
        cy = sy;
        break;
    }
  }
  if (ring.length >= 3) rings.push(ring);
  // Drop the duplicated closing point that fonts often include.
  return rings.map((r) => {
    const a = r[0], b = r[r.length - 1];
    return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 ? r.slice(0, -1) : r;
  });
}

export async function textShape(
  text: string,
  fontId: string,
  align: 'left' | 'center' | 'right',
  lineSpacing: number,
  letterSpacing: number,
): Promise<Shape2D> {
  const font = await loadFont(fontId);
  const size = 100;
  const lines = text.replace(/\r/g, '').split('\n');
  const opts = { kerning: true, letterSpacing };
  const widths = lines.map((l) => font.getAdvanceWidth(l, size, opts));
  const maxW = Math.max(1, ...widths);
  const rings: Vec2[][] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const x = align === 'left' ? 0 : align === 'right' ? maxW - widths[i] : (maxW - widths[i]) / 2;
    const y = i * size * lineSpacing;
    const path = font.getPath(line, x, y, size, opts);
    rings.push(...commandsToRings(path.commands, 1.5));
  });
  if (!rings.length) return EMPTY_SHAPE;
  return makeShape([{ rings, fillRule: 'nonzero' }]);
}
