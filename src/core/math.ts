import type { Bounds2, Mat4, Vec2, Vec3 } from './types';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, step = 0.01) => Math.round(v / step) * step;

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major matrix from basis vectors and an origin. */
export function frameMatrix(u: Vec3, v: Vec3, n: Vec3, o: Vec3): Mat4 {
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1];
}

export function mulMat(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

export function rotX(deg: number): Mat4 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotY(deg: number): Mat4 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function rotZ(deg: number): Mat4 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function applyMat(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function applyMatDir(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Number of segments for a full circle of radius r so that chords stay ~0.5 mm (multiple of 4). */
export function circleSegments(r: number, fine = true): number {
  const target = fine ? 0.45 : 0.9;
  const n = Math.ceil((2 * Math.PI * Math.max(r, 0.1)) / target);
  return Math.max(16, Math.min(fine ? 240 : 120, Math.ceil(n / 4) * 4));
}

/** Points of a rounded rectangle centred at the origin, counter-clockwise, `perCorner` arc segments per corner. */
export function roundedRectPoints(w: number, h: number, r: number, perCorner = 8): Vec2[] {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  const hw = w / 2, hh = h / 2;
  if (rr < 1e-3) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [
    [hw - rr, -hh + rr, -Math.PI / 2],
    [hw - rr, hh - rr, 0],
    [-hw + rr, hh - rr, Math.PI / 2],
    [-hw + rr, -hh + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = a0 + (i / perCorner) * (Math.PI / 2);
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return pts;
}

export function circlePoints(r: number, n: number, phase = 0): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

/** Regular polygon with a flat side facing -Y (the front), circumradius R. */
export function regularPolygon(sides: number, circumR: number): Vec2[] {
  const phase = -Math.PI / 2 + Math.PI / sides;
  return circlePoints(circumR, sides, phase);
}

/**
 * The outline of a regular polygon (circumradius `circumR`) with its corners rounded to radius `r`,
 * grown outward by `grow`: exactly what offsetting the polygon in by `r` and out by `r + grow` makes.
 */
export function roundedPolygonPoints(sides: number, circumR: number, r: number, grow = 0, perCorner = 8): Vec2[] {
  if (r <= 0 && grow <= 0) return regularPolygon(sides, circumR);
  const half = Math.PI / sides;
  const core = regularPolygon(sides, circumR - r / Math.cos(half));
  const phase = -Math.PI / 2 + Math.PI / sides;
  const out: Vec2[] = [];
  core.forEach(([x, y], k) => {
    const a = phase + (k * 2 * Math.PI) / sides;
    for (let i = 0; i <= perCorner; i++) {
      const t = a - half + (2 * half * i) / perCorner;
      out.push([x + (r + grow) * Math.cos(t), y + (r + grow) * Math.sin(t)]);
    }
  });
  return out;
}

export function rectPoints(w: number, h: number): Vec2[] {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
}

export function signedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

export function boundsOf(rings: Vec2[][]): Bounds2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function uid(prefix = 'g'): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/** Bounded Douglas-Peucker simplification of an open polyline. */
export function simplifyPolyline(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Simplify a closed ring (split at the farthest pair so both halves keep their shape). */
export function simplifyRing(ring: Vec2[], eps: number): Vec2[] {
  if (ring.length < 8 || eps <= 0) return ring;
  let far = 0, best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = simplifyPolyline(ring.slice(0, far + 1), eps);
  const b = simplifyPolyline([...ring.slice(far), ring[0]], eps);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/** Clip a convex polygon by another convex polygon (both counter-clockwise), Sutherland-Hodgman. */
export function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out;
}
