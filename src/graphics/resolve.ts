import { hashString as hash } from '../core/hash';
import type { Graphic, GraphicSource, Shape2D } from '../core/types';
import { traceImage } from './raster';
import { builtinShape, patternShape } from './shapes';
import { svgShape } from './svg';
import { onFontRegistered, textShape } from './text';

/** Cache key for the outline of a source; size-dependent sources (patterns) include the size. */
export function sourceKey(src: GraphicSource, g?: Pick<Graphic, 'w' | 'h'>): string {
  switch (src.kind) {
    case 'text':
      return `t|${src.font}|${src.align}|${src.lineSpacing}|${src.letterSpacing}|${src.text}`;
    case 'svg':
      return `s|${hash(src.svg)}`;
    case 'image':
      return `i|${hash(src.dataUrl)}|${src.threshold}|${src.invert}|${src.detail}`;
    case 'shape':
      return `b|${src.shape}|${src.sides}|${src.ratio}|${src.corner}`;
    case 'pattern':
      return `p|${src.pattern}|${src.cell}|${src.web}|${g?.w.toFixed(2)}|${g?.h.toFixed(2)}`;
  }
}

const cache = new Map<string, Promise<Shape2D>>();
const settled = new Map<string, Shape2D>();
const errors = new Map<string, string>();

let epoch = 0;
const epochListeners = new Set<() => void>();

// When a user font arrives, outlines (and errors) made without it are stale.
onFontRegistered((id) => {
  const prefix = `t|${id}|`;
  for (const map of [cache, settled, errors]) for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
  epoch++;
  epochListeners.forEach((l) => l());
});

/** Bumps whenever cached outlines are dropped, so views showing them can resolve them again. */
export const outlineEpoch = () => epoch;
export function onOutlineEpoch(fn: () => void) {
  epochListeners.add(fn);
  return () => epochListeners.delete(fn);
}

export function resolveShape(g: Graphic): Promise<Shape2D> {
  const key = sourceKey(g.source, g);
  let p = cache.get(key);
  if (!p) {
    const src = g.source;
    p = (async () => {
      switch (src.kind) {
        case 'text':
          return textShape(src.text || ' ', src.font, src.align, src.lineSpacing, src.letterSpacing);
        case 'svg':
          return svgShape(src.svg);
        case 'image':
          return traceImage(src.dataUrl, src.threshold, src.invert, src.detail);
        case 'shape':
          return builtinShape(src.shape, src.sides, src.ratio, src.corner);
        case 'pattern':
          return patternShape(src.pattern, g.w, g.h, src.cell, src.web);
      }
    })();
    cache.set(key, p);
    p.then(
      (s) => {
        settled.set(key, s);
        errors.delete(key);
      },
      (e) => errors.set(key, String(e?.message ?? e)),
    );
    if (cache.size > 200) {
      const first = cache.keys().next().value as string;
      cache.delete(first);
      settled.delete(first);
    }
  }
  return p;
}

/** Synchronous peek for rendering; undefined while the outline is still being made. */
export function peekShape(g: Graphic): Shape2D | undefined {
  return settled.get(sourceKey(g.source, g));
}

export function shapeError(g: Graphic): string | undefined {
  return errors.get(sourceKey(g.source, g));
}
