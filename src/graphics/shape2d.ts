import { boundsOf } from '../core/math';
import type { Graphic, PlacedGraphic, Shape2D, ShapeLayer, Vec2 } from '../core/types';

export function makeShape(layers: ShapeLayer[], bounds?: Shape2D['bounds']): Shape2D {
  const clean = layers
    .map((l) => ({ fillRule: l.fillRule, rings: l.rings.filter((r) => r.length >= 3) }))
    .filter((l) => l.rings.length > 0);
  return { layers: clean, bounds: bounds ?? boundsOf(clean.flatMap((l) => l.rings)) };
}

export const EMPTY_SHAPE: Shape2D = { layers: [], bounds: { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 } };

export function shapeSize(s: Shape2D): [number, number] {
  return [Math.max(1e-6, s.bounds.maxX - s.bounds.minX), Math.max(1e-6, s.bounds.maxY - s.bounds.minY)];
}

/** True when the graphic is drawn at its natural mm size (patterns), rather than stretched to w x h. */
export function isAbsolute(g: Graphic) {
  return g.source.kind === 'pattern';
}

/** Matrix (a, b, c, d, e, f) mapping shape coordinates to face coordinates. */
export function placementMatrix(g: Graphic, s: Shape2D): [number, number, number, number, number, number] {
  const [bw, bh] = shapeSize(s);
  const cx = (s.bounds.minX + s.bounds.maxX) / 2;
  const cy = (s.bounds.minY + s.bounds.maxY) / 2;
  const sx = (isAbsolute(g) ? 1 : g.w / bw) * (g.mirror ? -1 : 1);
  const sy = isAbsolute(g) ? 1 : g.h / bh;
  const t = (g.rotation * Math.PI) / 180;
  const c = Math.cos(t), sn = Math.sin(t);
  // p' = R * S * (p - centre) + (x, y)
  const a = c * sx, b = sn * sx, cc = -sn * sy, d = c * sy;
  const e = g.x - (a * cx + cc * cy);
  const f = g.y - (b * cx + d * cy);
  return [a, b, cc, d, e, f];
}

export function placeGraphic(g: Graphic, s: Shape2D): PlacedGraphic {
  const [a, b, c, d, e, f] = placementMatrix(g, s);
  const layers = s.layers.map((l) => ({
    fillRule: l.fillRule,
    rings: l.rings.map((r) => r.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f] as Vec2)),
  }));
  return {
    id: g.id,
    faceId: g.faceId,
    mode: g.mode,
    depth: g.depth,
    color: g.color,
    layers,
    frame: { x: g.x, y: g.y, w: g.w, h: g.h, rotation: g.rotation, mirror: g.mirror },
  };
}

/** SVG path data for a shape in its own coordinates (y up; flip with a transform when drawing). */
export function shapePathData(s: Shape2D): { d: string; fillRule: 'nonzero' | 'evenodd' }[] {
  return s.layers.map((l) => ({
    fillRule: l.fillRule,
    d: l.rings
      .map((r) => 'M' + r.map(([x, y]) => `${+x.toFixed(3)} ${+y.toFixed(3)}`).join('L') + 'Z')
      .join(''),
  }));
}
