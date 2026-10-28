import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { circlePoints } from '../core/math';
import type { Shape2D, ShapeLayer, Vec2 } from '../core/types';
import { makeShape } from './shape2d';

/** Outline a polyline as overlapping quads plus round joins/caps; union happens with the non-zero rule. */
function strokeOutline(pts: Vec2[], hw: number, closed: boolean, out: Vec2[][]) {
  const n = pts.length;
  if (n < 2 || hw <= 0) return;
  const segs = closed ? n : n - 1;
  const join = circlePoints(hw, 12);
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = (-dy / len) * hw, ny = (dx / len) * hw;
    out.push([
      [a[0] - nx, a[1] - ny],
      [b[0] - nx, b[1] - ny],
      [b[0] + nx, b[1] + ny],
      [a[0] + nx, a[1] + ny],
    ]);
  }
  for (const p of pts) out.push(join.map(([x, y]) => [x + p[0], y + p[1]] as Vec2));
}

function visible(style: Record<string, unknown>) {
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity ?? 1) > 0;
}

function paints(color: unknown, opacity: unknown) {
  return typeof color === 'string' && color !== 'none' && color !== 'transparent' && Number(opacity ?? 1) > 0;
}

export function svgShape(svgText: string): Shape2D {
  const data = new SVGLoader().parse(svgText);
  const layers: ShapeLayer[] = [];
  const strokes: Vec2[][] = [];
  for (const path of data.paths) {
    const style = (path.userData?.style ?? {}) as Record<string, unknown>;
    if (!visible(style)) continue;
    const subs = path.subPaths.map((sp) => {
      const pts = sp.getPoints().map((p) => [p.x, -p.y] as Vec2);
      const first = pts[0], last = pts[pts.length - 1];
      const closedPts = first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
      return { pts: closedPts ? pts.slice(0, -1) : pts, closed: (sp as { autoClose?: boolean }).autoClose || !!closedPts };
    });
    if (paints(style.fill, style.fillOpacity)) {
      const rings = subs.filter((s) => s.pts.length >= 3).map((s) => s.pts);
      if (rings.length) layers.push({ rings, fillRule: style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' });
    }
    const sw = Number(style.strokeWidth ?? 0);
    if (paints(style.stroke, style.strokeOpacity) && sw > 0) {
      for (const s of subs) strokeOutline(s.pts, sw / 2, s.closed, strokes);
    }
  }
  if (strokes.length) layers.push({ rings: strokes, fillRule: 'nonzero' });
  const shape = makeShape(layers);
  if (!shape.layers.length) throw new Error('No filled or stroked shapes found. Convert text to outlines before importing.');
  return shape;
}
