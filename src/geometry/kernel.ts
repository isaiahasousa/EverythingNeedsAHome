// Thin layer over manifold-3d: holds the WASM instance, tracks every object created during a
// build so it can be freed afterwards, and provides the solid helpers the box builders share.
import type { CrossSection, Manifold, ManifoldToplevel, Vec2 as MVec2 } from 'manifold-3d';
import { circleSegments, roundedRectPoints } from '../core/math';
import type { Mat4, Vec2, Vec3 } from '../core/types';

let wasm: ManifoldToplevel | null = null;
let fine = true;

type Deletable = { delete(): void; isDeleted?(): boolean };
const tracked: Deletable[] = [];

function isDeletable(o: unknown): o is Deletable {
  return !!o && typeof o === 'object' && typeof (o as Deletable).delete === 'function';
}

function register(result: unknown) {
  if (Array.isArray(result)) {
    for (const r of result) if (isDeletable(r)) tracked.push(r);
  } else if (isDeletable(result)) tracked.push(result);
}

const SKIP = new Set(['constructor', 'delete', 'isDeleted', 'deleteLater', 'isAliasOf', 'clone']);

function wrapAll(target: Record<string, unknown>) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (SKIP.has(name) || name.startsWith('_')) continue;
    const desc = Object.getOwnPropertyDescriptor(target, name);
    if (!desc || typeof desc.value !== 'function' || !desc.writable) continue;
    const orig = desc.value as (...a: unknown[]) => unknown;
    if ((orig as { __tracked?: boolean }).__tracked) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const r = orig.apply(this, args);
      register(r);
      return r;
    };
    (wrapped as { __tracked?: boolean }).__tracked = true;
    target[name] = wrapped;
  }
}

/** Install a loaded manifold module. Call once per worker / test process. */
export function setKernel(k: ManifoldToplevel) {
  wasm = k;
  wrapAll(k.Manifold as unknown as Record<string, unknown>);
  wrapAll(k.Manifold.prototype as unknown as Record<string, unknown>);
  wrapAll(k.CrossSection as unknown as Record<string, unknown>);
  wrapAll(k.CrossSection.prototype as unknown as Record<string, unknown>);
}

export function K(): ManifoldToplevel {
  if (!wasm) throw new Error('Geometry kernel not loaded');
  return wasm;
}

export function setQuality(q: 'draft' | 'fine') {
  fine = q === 'fine';
}

export function segs(r: number) {
  return circleSegments(r, fine);
}

/** Free every manifold object created since the last call. */
export function releaseAll() {
  for (const o of tracked) {
    try {
      if (!o.isDeleted || !o.isDeleted()) o.delete();
    } catch {
      /* already freed */
    }
  }
  tracked.length = 0;
}

// ------------------------------------------------------------------ 2D

export function poly(rings: Vec2[] | Vec2[][], rule: 'NonZero' | 'EvenOdd' | 'Positive' = 'Positive'): CrossSection {
  const arr = (Array.isArray(rings[0]) && Array.isArray((rings as Vec2[][])[0][0]) ? rings : [rings]) as MVec2[][];
  return K().CrossSection.ofPolygons(arr, rule);
}

export function rrect(w: number, h: number, r: number): CrossSection {
  const { CrossSection } = K();
  // A rectangle inset past its own middle is empty, not an error.
  if (!(w > 0.001 && h > 0.001)) return CrossSection.compose([]);
  const rr = Math.max(0, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
  if (rr < 0.05) return CrossSection.square([w, h], true);
  return CrossSection.square([w - 2 * rr, h - 2 * rr], true).offset(rr, 'Round', 2, segs(rr));
}

export function circle(r: number, n = segs(r)): CrossSection {
  return K().CrossSection.circle(r, n);
}

// ------------------------------------------------------------------ 3D

/**
 * An empty solid that is safe in booleans. (A zero-size cube or an extruded empty outline is flagged
 * InvalidConstruction, and any boolean it touches comes out empty too.)
 */
export const emptySolid = (): Manifold => K().Manifold.compose([]);

/** Extrude a cross-section between two Z levels. */
export function prism(cs: CrossSection, z0: number, z1: number): Manifold {
  if (cs.isEmpty() || !(z1 > z0)) return emptySolid();
  return cs.extrude(z1 - z0).translate([0, 0, z0]);
}

export function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Manifold {
  return K().Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
}

export function cylZ(r: number, z0: number, z1: number, x = 0, y = 0, n = segs(r)): Manifold {
  return K().Manifold.cylinder(z1 - z0, r, r, n).translate([x, y, z0]);
}

export function coneZ(r0: number, r1: number, z0: number, z1: number, n = segs(Math.max(r0, r1))): Manifold {
  return K().Manifold.cylinder(z1 - z0, r0, r1, n).translate([0, 0, z0]);
}

/** Cylinder along X from x0 to x1, axis through (y, z). */
export function cylX(r: number, x0: number, x1: number, y: number, z: number, n = segs(r)): Manifold {
  return K().Manifold.cylinder(x1 - x0, r, r, n).rotate([0, 90, 0]).translate([x0, y, z]);
}

/** Cylinder along Y from y0 to y1, axis through (x, z). */
export function cylY(r: number, y0: number, y1: number, x: number, z: number, n = segs(r)): Manifold {
  return K().Manifold.cylinder(y1 - y0, r, r, n).rotate([-90, 0, 0]).translate([x, y0, z]);
}

/**
 * Prism from a profile drawn in the XZ plane (x right, z up), extruded along Y from y0 to y1.
 */
export function profileXZ(pts: Vec2[], y0: number, y1: number): Manifold {
  const cs = poly(ensureCCW(pts));
  // extrude along +Z then map (x, y, z) -> (x, z, y): rotate +90 about X sends +Y->+Z and +Z->-Y.
  return cs.extrude(y1 - y0).rotate([90, 0, 0]).translate([0, y1, 0]);
}

/** Prism from a profile drawn in the YZ plane (y right, z up), extruded along X from x0 to x1. */
export function profileYZ(pts: Vec2[], x0: number, x1: number): Manifold {
  const cs = poly(ensureCCW(pts));
  // Draw in XY as (y, z), extrude along Z by length, then rotate so X->Y, Y->Z, Z->X.
  return cs.extrude(x1 - x0).rotate([90, 0, 90]).translate([x0, 0, 0]);
}

export function ensureCCW(pts: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a < 0 ? pts.slice().reverse() : pts;
}

export function transformed(m: Manifold, mat: Mat4): Manifold {
  return m.transform(mat as unknown as Parameters<Manifold['transform']>[0]);
}

export function unionAll(list: (Manifold | null | undefined)[]): Manifold {
  const items = list.filter((x): x is Manifold => !!x && !x.isEmpty());
  if (items.length === 0) return emptySolid();
  if (items.length === 1) return items[0];
  return K().Manifold.union(items);
}

export function empty(): Manifold {
  return emptySolid();
}

/**
 * Loft between rounded rectangles stacked along Z. Each level insets the outline by `inset` (mm) at height `z`.
 * Vertex correspondence is exact, so 45-degree chamfers (e.g. Gridfinity profiles) come out clean.
 */
export function loftRoundedRect(w: number, h: number, r: number, levels: { inset: number; z: number }[], perCorner = 10): Manifold {
  const loops = levels.map(({ inset, z }) => {
    const pts = roundedRectPoints(w - 2 * inset, h - 2 * inset, Math.max(0.05, r - inset), perCorner);
    return pts.map(([x, y]) => [x, y, z] as Vec3);
  });
  return loftLoops(loops);
}

/** Close a stack of equal-length CCW loops (bottom to top) into a solid. */
export function loftLoops(loops: Vec3[][]): Manifold {
  const n = loops[0].length;
  const m = loops.length;
  const verts: number[] = [];
  for (const loop of loops) for (const p of loop) verts.push(p[0], p[1], p[2]);
  const bottomC = m * n;
  const topC = bottomC + 1;
  const avg = (loop: Vec3[]) => {
    let x = 0, y = 0;
    for (const p of loop) { x += p[0]; y += p[1]; }
    return [x / loop.length, y / loop.length];
  };
  const b = avg(loops[0]);
  const t = avg(loops[m - 1]);
  verts.push(b[0], b[1], loops[0][0][2], t[0], t[1], loops[m - 1][0][2]);
  const tris: number[] = [];
  for (let k = 0; k < m - 1; k++) {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = k * n + i, bb = k * n + i1, c = (k + 1) * n + i1, d = (k + 1) * n + i;
      tris.push(a, bb, c, a, c, d);
    }
  }
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    tris.push(bottomC, i1, i);
    tris.push(topC, (m - 1) * n + i, (m - 1) * n + i1);
  }
  const { Mesh, Manifold } = K();
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
  mesh.merge();
  return Manifold.ofMesh(mesh);
}

export interface RidgeOpts {
  /** Radius where the ridge meets its core (external thread) or wall (internal thread). */
  rBase: number;
  /** Radius of the ridge tip. Larger than rBase for an external thread, smaller for an internal one. */
  rTip: number;
  /** Axial width at rBase and at the tip. */
  baseW: number;
  tipW: number;
  pitch: number;
  /** Z of the ridge centre at phi = 0; it rises pitch per turn (right-hand). */
  zAt0: number;
  phi0: number;
  phi1: number;
  /** How far the ridge sinks into its core so the union is clean. */
  embed: number;
  /** Angle (radians) over which the ridge height ramps in and out. */
  ramp?: number;
  stepDeg?: number;
}

/** A thread ridge swept along a helix: far lighter than twisting a lobed cross-section. */
export function helicalRidge(o: RidgeOpts): Manifold {
  // Fixed angular steps would leave big jars with chords that cut into the clearance; keep the
  // straight segments within 0.02 mm of the true helix whatever the radius.
  const rMax = Math.max(o.rBase, o.rTip);
  const chordStep = 2 * Math.acos(Math.max(0, 1 - 0.02 / Math.max(1, rMax)));
  const step = Math.min(((o.stepDeg ?? (fine ? 5 : 10)) * Math.PI) / 180, fine ? chordStep : 2 * chordStep);
  const n = Math.max(2, Math.ceil((o.phi1 - o.phi0) / step));
  const ramp = o.ramp ?? Math.PI / 2;
  const dir = Math.sign(o.rTip - o.rBase) || 1;
  const fullH = Math.abs(o.rTip - o.rBase);
  const slope = (o.baseW - o.tipW) / (2 * fullH); // axial run per radial rise on each flank
  const verts: number[] = [];
  let profileCCW = true;
  for (let j = 0; j <= n; j++) {
    const phi = o.phi0 + ((o.phi1 - o.phi0) * j) / n;
    const h = Math.max(0.12, Math.min(1, (phi - o.phi0) / ramp, (o.phi1 - phi) / ramp));
    const zc = o.zAt0 + (o.pitch * phi) / (2 * Math.PI);
    const rT = o.rBase + dir * fullH * h;
    const tw = o.baseW - 2 * slope * fullH * h;
    const rB = o.rBase - dir * o.embed;
    const bw = o.baseW + 2 * slope * o.embed;
    const prof: [number, number][] = [
      [rB, zc - bw / 2],
      [rT, zc - tw / 2],
      [rT, zc + tw / 2],
      [rB, zc + bw / 2],
    ];
    if (j === 0) {
      let a = 0;
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = prof[i], [x1, y1] = prof[(i + 1) % 4];
        a += x0 * y1 - x1 * y0;
      }
      profileCCW = a > 0;
    }
    const ordered = profileCCW ? prof : prof.slice().reverse();
    for (const [r, z] of ordered) verts.push(r * Math.cos(phi), r * Math.sin(phi), z);
  }
  const tris: number[] = [];
  for (let j = 0; j < n; j++)
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      const a = j * 4 + k, a1 = j * 4 + k1, b = (j + 1) * 4 + k, b1 = (j + 1) * 4 + k1;
      tris.push(a, b1, a1, a, b, b1);
    }
  tris.push(0, 1, 2, 0, 2, 3);
  const e = n * 4;
  tris.push(e, e + 2, e + 1, e, e + 3, e + 2);
  const { Mesh, Manifold } = K();
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
  const m = Manifold.ofMesh(mesh);
  if (m.volume() < 0) throw new Error('helicalRidge produced an inverted solid');
  return m;
}
