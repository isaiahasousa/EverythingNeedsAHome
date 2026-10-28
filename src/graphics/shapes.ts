import { circlePoints, roundedRectPoints } from '../core/math';
import type { PatternKind, Shape2D, ShapeKind, Vec2 } from '../core/types';
import { makeShape } from './shape2d';

export const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'circle', label: 'Circle' },
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'polygon', label: 'Polygon' },
  { kind: 'star', label: 'Star' },
  { kind: 'heart', label: 'Heart' },
  { kind: 'ring', label: 'Ring' },
  { kind: 'arrow', label: 'Arrow' },
  { kind: 'bolt', label: 'Bolt' },
  { kind: 'moon', label: 'Moon' },
  { kind: 'plus', label: 'Plus' },
  { kind: 'drop', label: 'Drop' },
  { kind: 'leaf', label: 'Leaf' },
];

export const PATTERNS: { kind: PatternKind; label: string }[] = [
  { kind: 'hex', label: 'Honeycomb' },
  { kind: 'circle', label: 'Round holes' },
  { kind: 'slot', label: 'Slots' },
  { kind: 'square', label: 'Squares' },
  { kind: 'diamond', label: 'Diamonds' },
];

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export function builtinShape(kind: ShapeKind, sides = 6, ratio = 0.5, corner = 0.15): Shape2D {
  const nz = (rings: Vec2[][]) => makeShape([{ rings, fillRule: 'nonzero' }]);
  switch (kind) {
    case 'circle':
      return nz([circlePoints(1, 96)]);
    case 'rect':
      return nz([roundedRectPoints(2, 2, Math.max(0, Math.min(1, corner)) * 1, 10)]);
    case 'polygon': {
      const n = Math.max(3, Math.min(24, Math.round(sides)));
      return nz([circlePoints(1, n, -Math.PI / 2 + Math.PI / n)]);
    }
    case 'star': {
      const n = Math.max(3, Math.min(24, Math.round(sides)));
      const inner = Math.max(0.15, Math.min(0.95, ratio));
      const pts: Vec2[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / n;
        const r = i % 2 === 0 ? 1 : inner;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return nz([pts]);
    }
    case 'heart': {
      const pts: Vec2[] = [];
      for (let i = 0; i < 160; i++) {
        const t = (i / 160) * Math.PI * 2;
        pts.push([16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
      }
      return nz([pts.reverse()]);
    }
    case 'ring': {
      const inner = Math.max(0.1, Math.min(0.95, ratio));
      return makeShape([{ rings: [circlePoints(1, 96), circlePoints(inner, 96)], fillRule: 'evenodd' }]);
    }
    case 'arrow':
      return nz([[[-1, -0.22], [0.25, -0.22], [0.25, -0.55], [1, 0], [0.25, 0.55], [0.25, 0.22], [-1, 0.22]]]);
    case 'bolt':
      return nz([[[0.15, 1], [-0.55, -0.1], [-0.05, -0.1], [-0.25, -1], [0.55, 0.15], [0.05, 0.15], [0.35, 1]]]);
    case 'moon': {
      const d = 0.55, rb = 0.85;
      const x = (d * d + 1 - rb * rb) / (2 * d);
      const y = Math.sqrt(Math.max(0, 1 - x * x));
      const ta = Math.atan2(y, x);
      const tb = Math.atan2(y, x - d);
      const outer = arc(0, 0, 1, ta, 2 * Math.PI - ta, 64);
      const inner = arc(d, 0, rb, 2 * Math.PI - tb, tb, 48).slice(1, -1);
      return nz([[...outer, ...inner]]);
    }
    case 'plus': {
      const a = 0.32;
      return nz([[[-a, -1], [a, -1], [a, -a], [1, -a], [1, a], [a, a], [a, 1], [-a, 1], [-a, a], [-1, a], [-1, -a], [-a, -a]]]);
    }
    case 'drop': {
      const pts: Vec2[] = [];
      for (let i = 0; i < 120; i++) {
        const t = (i / 120) * Math.PI * 2;
        pts.push([0.75 * Math.sin(t) * Math.abs(Math.sin(t / 2)) ** 1.2, Math.cos(t)]);
      }
      return nz([pts.reverse()]);
    }
    case 'leaf': {
      const c = 0.8, R = Math.sqrt(1 + c * c);
      const right = arc(-c, 0, R, Math.atan2(-1, c), Math.atan2(1, c), 40);
      const left = arc(c, 0, R, Math.atan2(1, -c), Math.atan2(-1, -c) + 2 * Math.PI, 40).slice(1, -1);
      return nz([[...right, ...left]]);
    }
  }
}

/** Most holes a vent pattern may have; past this the cut gets slow for little benefit. */
export const MAX_HOLES = 15000;

/** Vent / decorative hole pattern filling a w x h mm region; only whole cells are kept. */
export function patternShape(kind: PatternKind, w: number, h: number, cell: number, web: number): Shape2D {
  const s = Math.max(0.6, cell);
  const g = Math.max(0.4, web);
  const rings: Vec2[][] = [];
  const fits = (pts: Vec2[]) => pts.every(([x, y]) => Math.abs(x) <= w / 2 + 1e-6 && Math.abs(y) <= h / 2 + 1e-6);
  const push = (pts: Vec2[]) => {
    if (fits(pts)) rings.push(pts);
  };
  const grid = (px: number, py: number, offsetRows: boolean, make: (cx: number, cy: number) => Vec2[]) => {
    const nx = Math.floor(w / px) + 2;
    const ny = Math.floor(h / py) + 2;
    // Never stop part-way: a vent that is too dense is refused as a whole.
    if (Math.floor(w / px) * Math.floor(h / py) > MAX_HOLES)
      throw new Error(`This pattern would need more than ${MAX_HOLES.toLocaleString('en')} holes. Use bigger cells or make it smaller.`);
    for (let j = -ny; j <= ny; j++)
      for (let i = -nx; i <= nx; i++) {
        const cx = i * px + (offsetRows && j % 2 !== 0 ? px / 2 : 0);
        const cy = j * py;
        push(make(cx, cy));
      }
  };
  switch (kind) {
    case 'hex': {
      const Rc = s / Math.sqrt(3);
      const px = s + g;
      grid(px, px * Math.sin(Math.PI / 3), true, (cx, cy) => circlePoints(Rc, 6, Math.PI / 2).map(([x, y]) => [x + cx, y + cy] as Vec2));
      break;
    }
    case 'circle': {
      const px = s + g;
      const n = Math.max(12, Math.min(48, Math.round(s * 4)));
      grid(px, px * Math.sin(Math.PI / 3), true, (cx, cy) => circlePoints(s / 2, n).map(([x, y]) => [x + cx, y + cy] as Vec2));
      break;
    }
    case 'square':
      grid(s + g, s + g, false, (cx, cy) => roundedRectPoints(s, s, 0, 1).map(([x, y]) => [x + cx, y + cy] as Vec2));
      break;
    case 'diamond': {
      const d = s / Math.SQRT2;
      grid(s + g * Math.SQRT2, (s + g * Math.SQRT2) / 2, true, (cx, cy) => [[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]] as Vec2[]);
      break;
    }
    case 'slot': {
      const len = Math.min(h - 2 * g, Math.max(s * 4, 4));
      if (len > s) grid(s + g, len + g, false, (cx, cy) => roundedRectPoints(s, len, s / 2 - 0.01, 6).map(([x, y]) => [x + cx, y + cy] as Vec2));
      break;
    }
  }
  return makeShape([{ rings, fillRule: 'nonzero' }], { minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 });
}
