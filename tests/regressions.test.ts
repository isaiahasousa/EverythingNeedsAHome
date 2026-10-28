// Regression tests for problems found in adversarial review: each case failed before its fix.
import { readFileSync } from 'node:fs';
import type { Manifold } from 'manifold-3d';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BOX_TYPES, DEFAULT_PARAMS, normalizeParams } from '../src/boxes';
import { frameMatrix, pointInPolygon } from '../src/core/math';
import { applyGraphics } from '../src/geometry/graphics3d';
import { box, prism, releaseAll, rrect, transformed } from '../src/geometry/kernel';
import { placeGraphic } from '../src/graphics/shape2d';
import { builtinShape, patternShape } from '../src/graphics/shapes';
import { loadFont, registerCustomFont, registerSavedFonts } from '../src/graphics/text';
import { evalExpr } from '../src/ui/controls';
import type { BoxParams, FaceDef, Graphic, Vec2 } from '../src/core/types';
import { loadKernel } from './setup-kernel';

beforeAll(loadKernel);
afterEach(() => releaseAll());

function setup(type: keyof typeof BOX_TYPES, over: Partial<BoxParams> = {}) {
  const t = BOX_TYPES[type];
  const p = { ...DEFAULT_PARAMS, ...over } as BoxParams;
  const R = t.resolve(p);
  const warnings = t.warnings(p, R);
  const errors = warnings.filter((w) => w.level === 'error');
  return { t, p, R, warnings, errors, faces: () => t.faces(p, R), build: () => t.build(p, R) };
}

const overlap = (a: Manifold, b: Manifold) => a.intersect(b).volume();

/** Distance from `q` to the nearest edge of `ring`. */
function edgeDistance(q: Vec2, ring: Vec2[]) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * Material found along the face normal at face point (a, b), from `thickness + 0.25` behind the
 * surface to 0.3 in front of it. A wall exactly `thickness` thick with nothing attached reads `thickness`.
 */
function wallAt(part: Manifold, face: FaceDef, a: number, b: number) {
  const s = 0.6;
  const probe = box(a - s / 2, a + s / 2, b - s / 2, b + s / 2, -(face.thickness + 0.25), 0.3);
  return overlap(part, transformed(probe, frameMatrix(face.u, face.v, face.n, face.origin))) / (s * s);
}

describe('graphics faces sit on walls exactly as thick as they claim', () => {
  // Cut-through graphics only cut `thickness`; engraving assumes at least that much wall.
  const cases: [keyof typeof BOX_TYPES, Partial<BoxParams>][] = [
    ['tray', {}],
    ['lidded', { lidStyle: 'plug' }],
    ['lidded', { lidStyle: 'rabbet', wall: 3 }],
    ['lidded', { lidStyle: 'cap' }],
    ['lidded', { lidStyle: 'plug', snap: true }],
    ['polygon', { polyLid: true, lidStyle: 'plug', snap: true }],
    ['sliding', {}],
    ['hinged', {}],
    ['hinged', { alignLip: false }],
    ['drawers', {}],
    ['polygon', {}],
    ['polygon', { polyLid: true, lidStyle: 'cap' }],
    ['jar', {}],
    ['gridfinity', { gfDividersX: 1, gfDividersY: 1, gfLip: true, gfLabel: true }],
    ['gridfinity', { gfDividersX: 1, gfDividersY: 1, gfLip: false, gfLabel: false }],
  ];
  for (const [type, over] of cases) {
    it(`${type} ${JSON.stringify(over)}`, () => {
      const s = setup(type, over);
      expect(s.errors).toEqual([]);
      const solids = s.build();
      let probed = 0;
      for (const face of s.faces()) {
        if (face.kind !== 'plane') continue;
        const part = solids[face.partId];
        const ring = face.outline.length >= 3 ? (face.outline as Vec2[]) : null;
        const candidates: Vec2[] = [[0, 0], [face.width / 4, 0], [-face.width / 4, 0], [0, face.height / 4], [0, -face.height / 4]];
        for (const q of candidates) {
          if (Math.abs(q[0]) > face.width / 2 - 4.5 || Math.abs(q[1]) > face.height / 2 - 4.5) continue;
          if (ring && (!pointInPolygon(q, ring) || edgeDistance(q, ring) < 4.5)) continue;
          const got = wallAt(part, face, q[0], q[1]);
          const msg = `${face.id} at (${q[0].toFixed(1)}, ${q[1].toFixed(1)}): wall ${got.toFixed(2)} mm, face says ${face.thickness}`;
          // A solid face only promises at least `thickness`; every other face is exactly that thick.
          if (face.solid) expect(got, msg).toBeGreaterThanOrEqual(face.thickness - 0.05);
          else expect(got, msg).toBeCloseTo(face.thickness, 1);
          probed++;
        }
      }
      expect(probed).toBeGreaterThan(3);
    });
  }
});

describe('jar threads hold the cap', () => {
  const cases: Partial<BoxParams>[] = [
    { threadPitch: 1.5, threadDepth: 0.6, threadLength: 3, threadClearance: 0.25 },
    { threadPitch: 3, threadDepth: 1.2, threadLength: 3, threadClearance: 0.4 },
    { threadPitch: 5, threadDepth: 2, threadLength: 6, threadClearance: 1.0 },
    { threadPitch: 8, threadDepth: 3, threadLength: 3, threadClearance: 0.5, height: 80 },
  ];
  for (const over of cases) {
    it(JSON.stringify(over), () => {
      const s = setup('jar', over);
      expect(s.errors).toEqual([]);
      const { jar, cap } = s.build();
      const R = s.R.R as number;
      expect(overlap(jar, cap)).toBeLessThan(0.01);
      // Pulled straight up, the cap ridge must run into the neck ridge all the way round.
      const hit = jar.intersect(cap.translate([0, 0, (s.R.pitch as number) / 2]));
      expect(hit.volume()).toBeGreaterThan(1);
      const bb = hit.boundingBox();
      for (const axis of [0, 1]) {
        expect(bb.min[axis]).toBeLessThan(-0.6 * R);
        expect(bb.max[axis]).toBeGreaterThan(0.6 * R);
      }
    });
  }

  it('refuses a clearance that lets the cap slip off', () => {
    expect(setup('jar', { threadDepth: 0.6, threadClearance: 0.5 }).errors.length).toBe(1);
  });
});

describe('lid and hinge limits', () => {
  it('a deep plug lip stays clear of the floor', () => {
    const s = setup('lidded', { lidStyle: 'plug', height: 20, lidHeight: 6, lipHeight: 40 });
    expect(s.errors).toEqual([]);
    const { base, lid } = s.build();
    expect(overlap(base, lid)).toBeLessThan(0.01);
    expect(lid.boundingBox().min[2]).toBeGreaterThanOrEqual(s.p.floor + s.p.tolerance - 1e-6);
  });

  it('a rabbet lid keeps a printable neck and skirt', () => {
    const s = setup('lidded', { lidStyle: 'rabbet', wall: 1.2, tolerance: 0.3 });
    expect(s.R.neck as number).toBeGreaterThanOrEqual(0.2);
    expect(s.warnings.some((w) => w.level === 'warn' && /neck|skirt|thin/i.test(w.text))).toBe(true);
  });

  for (const [height, knuckleDiameter] of [[20, 4], [20, 12], [25, 7], [48, 12], [16, 7]] as const) {
    it(`hinged box ${height} mm tall with ${knuckleDiameter} mm knuckles is either refused or sound`, () => {
      const s = setup('hinged', { height, knuckleDiameter, lidHeight: 12 });
      if (s.errors.length) {
        expect((s.R.Hb as number) < (s.R.minHb as number) || (s.R.Hl as number) < (s.R.rk as number)).toBe(true);
        return;
      }
      const { base, lid } = s.build();
      // Nothing, not even the lid's knuckles, reaches below the bed.
      expect(base.boundingBox().min[2]).toBeGreaterThanOrEqual(-1e-6);
      expect(lid.boundingBox().min[2]).toBeGreaterThanOrEqual(-1e-6);
      expect(overlap(base, lid)).toBeLessThan(0.01);
    });
  }

  it('a box shorter than its lid is refused with the height it needs', () => {
    const s = setup('hinged', { height: 14, lidHeight: 12 });
    expect(s.errors.some((w) => /at least/.test(w.text))).toBe(true);
  });
});

describe('cabinet and sliding lid corners', () => {
  for (const [radius, wall, closedBack] of [[20, 2, true], [20, 2, false], [12, 3, true], [0, 1.2, true]] as const) {
    it(`drawer cabinet radius ${radius}, wall ${wall}, ${closedBack ? 'closed' : 'open'} back has no slits`, () => {
      const s = setup('drawers', { radius, wall, closedBack });
      const { sleeve } = s.build();
      expect(sleeve.decompose().length).toBe(1);
      // Open-backed compartments are tunnels (one hole each); anything more is a slit.
      expect(sleeve.genus()).toBe(closedBack ? 0 : (s.R.n as number));
    });
  }

  for (const [radius, wall, thumbGrip] of [[0, 1.2, true], [4, 2, true], [10, 2, false], [10, 3, true], [2, 1.2, false]] as const) {
    it(`sliding lid radius ${radius}, wall ${wall} keeps the corners closed`, () => {
      const s = setup('sliding', { radius, wall, thumbGrip });
      expect(s.errors).toEqual([]);
      const { base, lid } = s.build();
      for (const m of [base, lid]) {
        expect(m.decompose().length).toBe(1);
        expect(m.genus()).toBe(0);
      }
      expect(overlap(base, lid)).toBeLessThan(0.01);
    });
  }
});

describe('gridfinity label shelf', () => {
  it('drops row dividers that would be sealed under the shelf, and says so', () => {
    const s = setup('gridfinity', { gfY: 1, gfDividersY: 4, gfLabel: true });
    expect(s.warnings.some((w) => w.level === 'info' && /row divider/.test(w.text))).toBe(true);
    expect(s.build().bin.decompose().length).toBe(1);
  });

  it('dividers stop at the shelf top so a label strip lies flat', () => {
    const s = setup('gridfinity', { gfDividersX: 2, gfLabel: true, gfLip: true });
    const { bin } = s.build();
    const top = s.R.shelfTop as number, Hbody = s.R.Hbody as number;
    expect(overlap(bin, box(-0.3, 0.3, -5, 5, top + 0.05, Hbody - 0.05))).toBeLessThan(0.001);
  });
});

describe('graphics clean-up', () => {
  it('refuses to cut through a solid face', () => {
    const s = setup('gridfinity', { gfLabel: true });
    const out = applyGraphics(s.build(), s.faces(), [placeGraphic(graphic({ faceId: 'label', w: 20, h: 8 }), builtinShape('star', 5, 0.45, 0))]);
    expect(out.warnings.some((w) => /solid underneath/.test(w.text))).toBe(true);
  });

  const graphic = (over: Partial<Graphic>): Graphic => ({
    id: 'g1', faceId: 'front', source: { kind: 'shape', shape: 'ring', sides: 6, ratio: 0.5, corner: 0 },
    x: 0, y: 0, w: 24, h: 24, lockAspect: true, rotation: 0, mirror: false, mode: 'cut', depth: 1,
    color: '#d0402b', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });

  it('warns when a cut-through graphic leaves a loose piece, and not otherwise', () => {
    const s = setup('tray');
    const faces = s.faces();
    const solids = s.build();
    const ring = applyGraphics(solids, faces, [placeGraphic(graphic({}), builtinShape('ring', 6, 0.5, 0))]);
    expect(ring.warnings.some((w) => /loose pieces/.test(w.text))).toBe(true);
    const star = applyGraphics(solids, faces, [placeGraphic(graphic({ source: { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0 } }), builtinShape('star', 5, 0.45, 0))]);
    expect(star.warnings.some((w) => /loose pieces/.test(w.text))).toBe(false);
  });

  it('removes specks smaller than half a cubic millimetre', () => {
    const s = setup('tray');
    const faces = s.faces();
    const solids = s.build();
    // A 0.6 mm ring cut through a 2 mm wall leaves a tiny loose disc in the middle.
    const out = applyGraphics(solids, faces, [placeGraphic(graphic({ w: 0.9, h: 0.9 }), builtinShape('ring', 6, 0.5, 0))]);
    for (const piece of out.solids.base.decompose()) expect(piece.volume()).toBeGreaterThanOrEqual(0.5);
  });
});

describe('review round 2', () => {
  const outsideOuter = (m: Manifold, W: number, D: number, r: number, H: number) => m.subtract(prism(rrect(W, D, r), -1, H + 1)).volume();

  it('tray dividers stay inside rounded corners', () => {
    for (const over of [{ radius: 30, dividersY: 4 }, { width: 120, depth: 40, height: 30, radius: 19.5, dividersY: 4, dividersX: 6 }] as Partial<BoxParams>[]) {
      const s = setup('tray', over);
      const { base } = s.build();
      expect(outsideOuter(base, s.R.outer[0], s.R.outer[1], s.R.r as number, s.R.outer[2])).toBeLessThan(0.001);
      expect(base.decompose().length).toBe(1);
    }
  });

  it('gridfinity shelf and dividers stay inside the bin, and the label face clears the lip', () => {
    for (const gfWall of [0.8, 1.2, 2.4]) {
      const s = setup('gridfinity', { gfWall, gfLabel: true, gfLip: true, gfDividersX: 12, gfDividersY: 3 });
      const { bin } = s.build();
      expect(outsideOuter(bin, s.R.W as number, s.R.D as number, 3.75, s.R.H as number)).toBeLessThan(0.001);
      const label = s.faces().find((f) => f.id === 'label')!;
      expect(label.origin[1] + label.height / 2).toBeLessThanOrEqual((s.R.D as number) / 2 - 2.6);
    }
  });

  it('refuses a flush lid too short to cover the neck, and accepts one that is tall enough', () => {
    for (const type of ['lidded', 'polygon'] as const) {
      expect(setup(type, { polyLid: true, lidStyle: 'rabbet', lidHeight: 2, lidTop: 2 }).errors.length).toBeGreaterThan(0);
      const ok = setup(type, { polyLid: true, lidStyle: 'rabbet', lidHeight: 4, lidTop: 2, wall: 3 });
      expect(ok.errors).toEqual([]);
      const { base, lid } = ok.build();
      expect(overlap(base, lid)).toBeLessThan(0.01);
    }
  });

  it('refuses a slip-over cap taller than the box', () => {
    expect(setup('lidded', { lidStyle: 'cap', lidHeight: 60 }).errors.length).toBeGreaterThan(0);
    expect(setup('lidded', { lidStyle: 'cap', lidHeight: 30 }).errors).toEqual([]);
  });

  it('refuses lips too thick for the box instead of dropping the lid', () => {
    expect(setup('lidded', { depth: 15, lidStyle: 'plug', lipThickness: 6 }).errors.length).toBeGreaterThan(0);
    expect(setup('hinged', { depth: 10, lipThickness: 4 }).errors.length).toBeGreaterThan(0);
    expect(setup('polygon', { diameter: 15, wall: 6.3, polyLid: true, lidStyle: 'plug' }).errors.length).toBeGreaterThan(0);
  });

  it('refuses a sliding lid that would not be held, or a box too narrow for one', () => {
    for (const over of [{ grooveDepth: 0.5, tolerance: 0.5 }, { grooveDepth: 0.3, tolerance: 0.3 }, { tolerance: 1 }, { wall: 1.2, tolerance: 0.8 }, { width: 10, wall: 4.5 }] as Partial<BoxParams>[])
      expect(setup('sliding', over).errors.length, JSON.stringify(over)).toBeGreaterThan(0);
  });

  it('sliding walls under graphics are full thickness right up to the face top', () => {
    const s = setup('sliding');
    const { base } = s.build();
    for (const f of s.faces().filter((x) => x.partId === 'base' && x.id !== 'bottom')) {
      const got = wallAt(base, f, 0, f.height / 2 - 0.4);
      expect(got, f.id).toBeCloseTo(f.thickness, 1);
    }
  });

  it('jar body wall is as thick as its face claims, top to bottom', () => {
    const s = setup('jar');
    const { jar } = s.build();
    const f = s.faces().find((x) => x.id === 'front')!;
    for (const v of [-f.height / 2 + 2, 0, f.height / 2 - 0.4]) {
      const z = f.origin[2] + v;
      const R = f.radius!;
      const probe = box(R - f.thickness - 0.25, R + 0.3, -0.3, 0.3, z - 0.3, z + 0.3).rotate([0, 0, -90]);
      expect(overlap(jar, probe) / 0.36, `z ${z.toFixed(1)}`).toBeCloseTo(f.thickness, 1);
    }
  });

  it('large jars with fine threads fit and stay in one piece', () => {
    for (const diameter of [220, 300]) {
      const s = setup('jar', { diameter, threadPitch: 1.5, threadClearance: 0.4, height: 40 });
      const { jar, cap } = s.build();
      expect(overlap(jar, cap)).toBeLessThan(0.01);
      expect(cap.decompose().length).toBe(1);
    }
  });

  it('warns when raised graphics would stop a Gridfinity bin fitting or stacking', () => {
    const s = setup('gridfinity', { gfLabel: true, gfLip: true });
    const solids = s.build();
    const faces = s.faces();
    const g = (faceId: string, depth: number) =>
      placeGraphic({ id: 'g', faceId, source: { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0 }, x: 0, y: 0, w: 6, h: 6, lockAspect: true, rotation: 0, mirror: false, mode: 'emboss', depth, color: '#fff', lithoMin: 0.8, lithoMax: 3, hidden: false }, builtinShape('star', 5, 0.45, 0));
    expect(applyGraphics(solids, faces, [g('front', 1)]).warnings.some((w) => /fit its grid/.test(w.text))).toBe(true);
    expect(applyGraphics(solids, faces, [g('label', 2)]).warnings.some((w) => /stacked on top/.test(w.text))).toBe(true);
    expect(applyGraphics(solids, faces, [g('label', 0.8)]).warnings.some((w) => /proud/.test(w.text))).toBe(false);
  });

  it('vent patterns fill the whole area or refuse, never stop part-way', () => {
    const s = patternShape('hex', 300, 300, 3, 1.6);
    const ys = s.layers[0].rings.map((r) => r[0][1]);
    expect(Math.max(...ys)).toBeGreaterThan(140);
    expect(Math.min(...ys)).toBeLessThan(-140);
    expect(() => patternShape('hex', 400, 400, 1, 0.6)).toThrow(/holes/);
  });

  it('project files are kept inside the allowed ranges', () => {
    const p = normalizeParams({ dividersX: 100000, gfX: 5000, width: 1e7, wall: -3, threadPitch: Number.NaN, lidStyle: 'bogus' as never });
    expect(p.dividersX).toBe(12);
    expect(p.gfX).toBe(8);
    expect(p.width).toBe(400);
    expect(p.wall).toBe(0.8);
    expect(p.threadPitch).toBe(DEFAULT_PARAMS.threadPitch);
    expect(p.lidStyle).toBe(DEFAULT_PARAMS.lidStyle);
  });

  it('reads mixed fractions with whole numbers of any length', () => {
    for (const [s, v] of [['10 1/2', 10.5], ['12 3/4', 12.75], ['3 1/2', 3.5], ['100-12 3/4', 87.25]] as const) expect(evalExpr(s), s).toBeCloseTo(v, 9);
  });

  it('the drawer ledge tab overhang is no steeper than 45 degrees', () => {
    const s = setup('drawers');
    const { drawer1 } = s.build();
    const mesh = drawer1.getMesh();
    const P = mesh.vertProperties, T = mesh.triVerts, np = mesh.numProp;
    let worst = 0;
    for (let i = 0; i < T.length; i += 3) {
      const a = [0, 1, 2].map((k) => [P[T[i + k] * np], P[T[i + k] * np + 1], P[T[i + k] * np + 2]]);
      const u = a[1].map((v, k) => v - a[0][k]), w = a[2].map((v, k) => v - a[0][k]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      const minZ = Math.min(a[0][2], a[1][2], a[2][2]);
      // Downward-facing surfaces above the drawer's own bottom are overhangs.
      if (len > 1e-9 && n[2] / len < -1e-3 && minZ > (s.R.ch as number) * 0 + 0.01 && n[2] / len > -0.999) worst = Math.max(worst, (Math.acos(-n[2] / len) * 180) / Math.PI);
    }
    // Angle between the surface normal and straight down: 45 means a 45-degree overhang.
    expect(90 - worst).toBeGreaterThanOrEqual(44.9);
  });
});

describe('custom fonts', () => {
  const file = new Uint8Array(readFileSync(new URL('../public/fonts/pacifico.woff', import.meta.url))).buffer;

  it('never falls back to another font for a missing user font', async () => {
    await expect(loadFont('custom:not-uploaded')).rejects.toThrow(/not loaded/);
  });

  it('fonts saved in a project load again', async () => {
    const saved = await registerCustomFont(file, 'Mine');
    expect(saved.id).toBe('custom:Mine');
    registerSavedFonts([{ ...saved, id: 'custom:FromFile' }]);
    const font = await loadFont('custom:FromFile');
    expect(font.unitsPerEm).toBeGreaterThan(0);
  });
});
