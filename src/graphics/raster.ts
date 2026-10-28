import { signedArea, simplifyRing } from '../core/math';
import type { Shape2D, Vec2 } from '../core/types';
import { makeShape } from './shape2d';

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The image could not be read. Use a PNG, JPG, WebP or GIF file.'));
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

/** Luminance (0-255) of the image composited over white, resized to fit `w` x `h`. */
export function grayscale(img: HTMLImageElement, w: number, h: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]);
  return out;
}

export function fitSize(img: HTMLImageElement, maxDim: number): [number, number] {
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  return [Math.max(2, Math.round(img.naturalWidth * s)), Math.max(2, Math.round(img.naturalHeight * s))];
}

/**
 * Marching squares on a thresholded luminance field. Dark pixels are solid unless `invert`.
 * Returns closed rings (y up) for an even-odd fill.
 */
export function traceField(gray: Uint8Array, w: number, h: number, threshold: number, invert: boolean, simplifyEps = 0.6): Vec2[][] {
  const W = w + 2, H = h + 2;
  const s = new Float32Array(W * H).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      let d = invert ? v - threshold : threshold - v;
      if (d === 0) d = -0.01;
      s[(y + 1) * W + (x + 1)] = d;
    }
  const hkey = (x: number, y: number) => (y * W + x) * 2;
  const vkey = (x: number, y: number) => (y * W + x) * 2 + 1;
  const pts = new Map<number, Vec2>();
  const links = new Map<number, number[]>();
  const point = (key: number, ax: number, ay: number, bx: number, by: number) => {
    if (pts.has(key)) return;
    const sa = s[ay * W + ax], sb = s[by * W + bx];
    const t = sa / (sa - sb);
    pts.set(key, [ax + t * (bx - ax), -(ay + t * (by - ay))]);
  };
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const v0 = s[y * W + x], v1 = s[y * W + x + 1], v2 = s[(y + 1) * W + x + 1], v3 = s[(y + 1) * W + x];
      const c = (v0 > 0 ? 1 : 0) | (v1 > 0 ? 2 : 0) | (v2 > 0 ? 4 : 0) | (v3 > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const e0 = hkey(x, y), e1 = vkey(x + 1, y), e2 = hkey(x, y + 1), e3 = vkey(x, y);
      const P = (e: number) => {
        if (e === e0) point(e, x, y, x + 1, y);
        else if (e === e1) point(e, x + 1, y, x + 1, y + 1);
        else if (e === e2) point(e, x, y + 1, x + 1, y + 1);
        else point(e, x, y, x, y + 1);
        return e;
      };
      const seg = (a: number, b: number) => link(P(a), P(b));
      const centre = (v0 + v1 + v2 + v3) / 4 > 0;
      switch (c) {
        case 1: case 14: seg(e3, e0); break;
        case 2: case 13: seg(e0, e1); break;
        case 3: case 12: seg(e3, e1); break;
        case 4: case 11: seg(e1, e2); break;
        case 6: case 9: seg(e0, e2); break;
        case 7: case 8: seg(e3, e2); break;
        case 5:
          if (centre) { seg(e0, e1); seg(e2, e3); } else { seg(e3, e0); seg(e1, e2); }
          break;
        case 10:
          if (centre) { seg(e3, e0); seg(e1, e2); } else { seg(e0, e1); seg(e2, e3); }
          break;
      }
    }
  const rings: Vec2[][] = [];
  const seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const ring: Vec2[] = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      ring.push(pts.get(cur)!);
      const nb = links.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    if (ring.length < 3) continue;
    const simple = simplifyRing(ring, simplifyEps);
    if (Math.abs(signedArea(simple)) >= 4) rings.push(simple);
  }
  return rings;
}

const DETAIL_PX = [0, 160, 260, 380, 560, 800];

export async function traceImage(dataUrl: string, threshold: number, invert: boolean, detail: number): Promise<Shape2D> {
  const img = await loadImage(dataUrl);
  const [w, h] = fitSize(img, DETAIL_PX[Math.max(1, Math.min(5, Math.round(detail)))]);
  const gray = grayscale(img, w, h);
  const rings = traceField(gray, w, h, threshold, invert);
  if (!rings.length) throw new Error('Nothing dark enough to trace. Move the threshold slider or turn on Invert.');
  return makeShape([{ rings, fillRule: 'evenodd' }]);
}

/** Pixel grid for a lithophane of w x h mm at ~0.25 mm per sample. */
export async function lithophanePixels(dataUrl: string, wmm: number, hmm: number, fine: boolean) {
  const img = await loadImage(dataUrl);
  const step = fine ? 0.25 : 0.5;
  const pw = Math.max(8, Math.min(fine ? 360 : 180, Math.round(wmm / step)));
  const ph = Math.max(8, Math.min(fine ? 360 : 180, Math.round(hmm / step)));
  return { pixels: grayscale(img, pw, ph), pw, ph };
}

export async function imageAspect(dataUrl: string): Promise<number> {
  const img = await loadImage(dataUrl);
  return img.naturalWidth / Math.max(1, img.naturalHeight);
}
