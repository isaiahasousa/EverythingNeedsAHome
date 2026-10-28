import type { Manifold } from 'manifold-3d';
import { clipConvex, rectPoints, roundedRectPoints } from '../core/math';
import type {
  BoxParams,
  BoxTypeId,
  FaceDef,
  ParamDef,
  ParamGroup,
  PartInfo,
  Resolved,
  Vec2,
  Vec3,
  Warning,
} from '../core/types';

export interface BoxType {
  id: BoxTypeId;
  name: string;
  tagline: string;
  /** Size-step fields (dimensions). */
  dims: ParamDef[];
  /** Whether the inside/outside toggle applies. */
  usesDimsMode: boolean;
  /** Details-step groups. */
  groups: ParamGroup[];
  resolve(p: BoxParams): Resolved;
  faces(p: BoxParams, r: Resolved): FaceDef[];
  parts(p: BoxParams, r: Resolved): PartInfo[];
  warnings(p: BoxParams, r: Resolved): Warning[];
  /** Runs in the worker: returns one solid per part id, in the assembled pose. */
  build(p: BoxParams, r: Resolved): Record<string, Manifold>;
}

// ------------------------------------------------------------- common fields

export const F = {
  width: { kind: 'length', key: 'width', label: 'Width', min: 10, max: 400, help: 'Left to right (X).' } as ParamDef,
  depth: { kind: 'length', key: 'depth', label: 'Depth', min: 10, max: 400, help: 'Front to back (Y).' } as ParamDef,
  height: { kind: 'length', key: 'height', label: 'Height', min: 6, max: 400, help: 'Total height when closed (Z).' } as ParamDef,
  wall: { kind: 'length', key: 'wall', label: 'Wall thickness', min: 0.8, max: 10, step: 0.1, help: 'Use a multiple of your line width, e.g. 1.6 or 2.0 mm for a 0.4 mm nozzle.' } as ParamDef,
  floor: { kind: 'length', key: 'floor', label: 'Floor thickness', min: 0.6, max: 10, step: 0.1 } as ParamDef,
  radius: { kind: 'length', key: 'radius', label: 'Corner radius', min: 0, max: 60, step: 0.5, help: 'Rounds the vertical edges.' } as ParamDef,
  tolerance: { kind: 'length', key: 'tolerance', label: 'Fit clearance', min: 0, max: 1.5, step: 0.05, help: 'Gap between mating parts. 0.15-0.3 mm suits most printers.' } as ParamDef,
};

// ------------------------------------------------------------- dims helpers

/** Outer W/D/H for a rectangular box. `extraH` is what sits above the usable inner height (lid, floor). */
export function rectDims(p: BoxParams, extraH: number) {
  const t = p.wall;
  if (p.dimsMode === 'inner') {
    return { W: p.width + 2 * t, D: p.depth + 2 * t, H: p.height + extraH };
  }
  return { W: p.width, D: p.depth, H: p.height };
}

export function clampRadius(r: number, W: number, D: number) {
  return Math.max(0, Math.min(r, W / 2 - 0.5, D / 2 - 0.5));
}

// ------------------------------------------------------------- faces

interface FaceOpts {
  onBed?: boolean;
  outline?: Vec2[];
  solid?: boolean;
  raiseLimit?: FaceDef['raiseLimit'];
  innerRoom?: number;
}

/** Free space behind faces with nothing mating behind them: plenty for any lithophane. */
export const OPEN_BEHIND = 50;

/** Room behind a wall facing an open cavity: up to half the narrowest inside dimension. */
export const cavityRoom = (R: Resolved) => Math.max(0, Math.min(OPEN_BEHIND, R.inner[0] / 2 - 0.5, R.inner[1] / 2 - 0.5));

/** Room above a floor: the usable inside height. */
export const floorRoom = (R: Resolved) => Math.max(0, Math.min(OPEN_BEHIND, R.inner[2] - 0.5));

/** The same faces with `innerRoom` set (how far a lithophane may reach inward past the wall). */
export const withRoom = (faces: FaceDef[], innerRoom: number): FaceDef[] => faces.map((f) => ({ ...f, innerRoom }));

export function planeFace(
  id: string,
  label: string,
  partId: string,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  n: Vec3,
  width: number,
  height: number,
  thickness: number,
  opts: FaceOpts = {},
): FaceDef {
  return {
    id,
    label,
    partId,
    kind: 'plane',
    origin,
    u,
    v,
    n,
    width: Math.max(0, width),
    height: Math.max(0, height),
    outline: opts.outline ?? rectPoints(Math.max(0, width), Math.max(0, height)),
    thickness,
    onBed: opts.onBed,
    solid: opts.solid,
    raiseLimit: opts.raiseLimit,
    innerRoom: opts.innerRoom,
  };
}

/**
 * The four outer walls of a rectangular section between z0 and z1, centred at (cx, cy).
 * Flat width excludes the rounded corners so graphics never hang over a curve.
 */
export function wallFaces(
  partId: string,
  W: number,
  D: number,
  z0: number,
  z1: number,
  r: number,
  t: number,
  idPrefix = '',
  labelPrefix = '',
  which: ('front' | 'back' | 'left' | 'right')[] = ['front', 'back', 'left', 'right'],
  cx = 0,
  cy = 0,
): FaceDef[] {
  const zc = (z0 + z1) / 2;
  const h = z1 - z0;
  const out: FaceDef[] = [];
  const name = (s: string) => (labelPrefix ? `${labelPrefix} ${s.toLowerCase()}` : s);
  for (const w of which) {
    if (w === 'front')
      out.push(planeFace(idPrefix + 'front', name('Front'), partId, [cx, cy - D / 2, zc], [1, 0, 0], [0, 0, 1], [0, -1, 0], W - 2 * r, h, t));
    if (w === 'back')
      out.push(planeFace(idPrefix + 'back', name('Back'), partId, [cx, cy + D / 2, zc], [-1, 0, 0], [0, 0, 1], [0, 1, 0], W - 2 * r, h, t));
    if (w === 'left')
      out.push(planeFace(idPrefix + 'left', name('Left'), partId, [cx - W / 2, cy, zc], [0, -1, 0], [0, 0, 1], [-1, 0, 0], D - 2 * r, h, t));
    if (w === 'right')
      out.push(planeFace(idPrefix + 'right', name('Right'), partId, [cx + W / 2, cy, zc], [0, 1, 0], [0, 0, 1], [1, 0, 0], D - 2 * r, h, t));
  }
  return out;
}

export function topFace(id: string, label: string, partId: string, W: number, D: number, r: number, z: number, t: number, onBed: boolean, cy = 0): FaceDef {
  return planeFace(id, label, partId, [0, cy, z], [1, 0, 0], [0, 1, 0], [0, 0, 1], W, D, t, {
    onBed,
    outline: roundedRectPoints(W, D, r, 6),
  });
}

export function bottomFace(partId: string, W: number, D: number, r: number, t: number, outline?: Vec2[]): FaceDef {
  return planeFace('bottom', 'Bottom', partId, [0, 0, 0], [1, 0, 0], [0, -1, 0], [0, 0, -1], W, D, t, {
    onBed: true,
    outline: outline ?? roundedRectPoints(W, D, r, 6),
  });
}

// ------------------------------------------------------------- warnings

export function commonWarnings(p: BoxParams, r: Resolved): Warning[] {
  const w: Warning[] = [];
  if (p.wall < 1.2) w.push({ level: 'warn', text: `Walls of ${p.wall} mm are fragile. 1.2 mm or more prints reliably with a 0.4 mm nozzle.` });
  // Whether there is a cavity at all: under a lid that hangs inside (`clearH`), the full height counts.
  const dims = [r.inner[0], r.inner[1], typeof r.clearH === 'number' ? r.clearH : r.inner[2]];
  if (dims.some((v) => v <= 0)) w.push({ level: 'error', text: 'Walls and floor are thicker than the box. Increase the size or reduce the thickness.' });
  else if (dims.some((v) => v < 2)) w.push({ level: 'error', text: 'The inside would be less than 2 mm across. Increase the size or reduce the wall and floor thickness.' });
  return w;
}

export const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * Cut a rectangular notch, `halfW` either side of the centre line and `depth` deep, into the straight
 * bottom (or top) edge of a convex counter-clockwise outline. If the edge is not straight that far,
 * the whole strip along the edge is removed instead.
 */
export function notchOutline(outline: Vec2[], halfW: number, depth: number, edge: 'top' | 'bottom'): Vec2[] {
  if (outline.length < 3) return [];
  const vs = outline.map((q) => q[1]);
  const vEdge = edge === 'bottom' ? Math.min(...vs) : Math.max(...vs);
  const dir = edge === 'bottom' ? 1 : -1; // counter-clockwise: the bottom edge runs +x, the top edge -x
  // A notch reaching the far side would split what is left in two: nothing usable remains.
  if (depth >= Math.max(...vs) - Math.min(...vs) - 0.5) return [];
  const inner = vEdge + dir * depth;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (Math.abs(a[1] - vEdge) > 1e-6 || Math.abs(b[1] - vEdge) > 1e-6 || (b[0] - a[0]) * dir <= 0) continue;
    if (Math.min(a[0], b[0]) > -halfW - 0.2 || Math.max(a[0], b[0]) < halfW + 0.2) break;
    const notch: Vec2[] =
      edge === 'bottom'
        ? [[-halfW, vEdge], [-halfW, inner], [halfW, inner], [halfW, vEdge]]
        : [[halfW, vEdge], [halfW, inner], [-halfW, inner], [-halfW, vEdge]];
    return [...outline.slice(0, i + 1), ...notch, ...outline.slice(i + 1)];
  }
  const big = 1e4;
  const keep: Vec2[] = edge === 'bottom' ? [[-big, inner], [big, inner], [big, big], [-big, big]] : [[-big, -big], [big, -big], [big, inner], [-big, inner]];
  return clipConvex(outline, keep);
}

/** Face outline (w x h, centred) with a notch cut down from the middle of its top edge. */
export function topNotchOutline(w: number, h: number, notch: { kind: 'arc'; r: number } | { kind: 'rect'; halfW: number; depth: number }): Vec2[] {
  const hw = w / 2, hh = h / 2;
  const pts: Vec2[] = [[-hw, -hh], [hw, -hh], [hw, hh]];
  if (notch.kind === 'arc') {
    const r = Math.max(0.5, Math.min(notch.r, hw - 0.5, h - 0.5));
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI;
      pts.push([r * Math.cos(a), hh - r * Math.sin(a)]);
    }
  } else {
    const x = Math.max(0.5, Math.min(notch.halfW, hw - 0.5));
    const y = hh - Math.max(0.5, Math.min(notch.depth, h - 0.5));
    pts.push([x, hh], [x, y], [-x, y], [-x, hh]);
  }
  pts.push([-hw, hh]);
  return pts;
}
