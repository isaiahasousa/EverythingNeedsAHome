// Regression tests for problems found in adversarial review: each case failed before its fix.
import { readFileSync } from 'node:fs';
import type { Manifold } from 'manifold-3d';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BOX_ORDER, BOX_TYPES, DEFAULT_PARAMS, normalizeParams } from '../src/boxes';
import { lengthProps } from '../src/ui/ParamField';
import { applyMat, frameMatrix, IDENTITY, pointInPolygon, signedArea } from '../src/core/math';
import { layoutParts, PRINTERS } from '../src/export/layout';
import { runBuild } from '../src/geometry/build';
import { normalizeProject } from '../src/state/project';
import { applyGraphics } from '../src/geometry/graphics3d';
import { box, prism, releaseAll, rrect, transformed } from '../src/geometry/kernel';
import { placeGraphic } from '../src/graphics/shape2d';
import { builtinShape, patternShape } from '../src/graphics/shapes';
import { customFontName, loadFont, registerCustomFont, registerSavedFonts } from '../src/graphics/text';
import { sourceKey } from '../src/graphics/resolve';
import { evalExpr } from '../src/ui/controls';
import type { BoxParams, FaceDef, Graphic, PartMesh, Vec2 } from '../src/core/types';
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
    expect(saved.id.startsWith('custom:Mine#')).toBe(true);
    expect(customFontName(saved.id)).toBe('Mine');
    registerSavedFonts([{ ...saved, id: 'custom:FromFile' }]);
    const font = await loadFont('custom:FromFile');
    expect(font.unitsPerEm).toBeGreaterThan(0);
  });
});

describe('review round 3', () => {
  /** Smallest gap between any two holes of a vent pattern (vertex-to-edge distances). */
  function minGap(rings: Vec2[][]) {
    const segDist = (q: Vec2, a: Vec2, b: Vec2) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
    };
    const centre = (r: Vec2[]) => r.reduce((s, q) => [s[0] + q[0] / r.length, s[1] + q[1] / r.length] as Vec2, [0, 0] as Vec2);
    let best = Infinity;
    for (let i = 0; i < rings.length; i++)
      for (let j = 0; j < rings.length; j++) {
        if (i === j) continue;
        const [ci, cj] = [centre(rings[i]), centre(rings[j])];
        if (Math.hypot(ci[0] - cj[0], ci[1] - cj[1]) > 40) continue;
        for (const q of rings[i]) for (let k = 0; k < rings[j].length; k++) best = Math.min(best, segDist(q, rings[j][k], rings[j][(k + 1) % rings[j].length]));
      }
    return best;
  }

  it('every vent pattern leaves exactly the web asked for between holes', () => {
    for (const kind of ['hex', 'circle', 'square', 'diamond', 'slot'] as const)
      for (const [cell, web] of [[5, 1.6], [3, 1.2], [10, 1.6], [8, 2]] as const) {
        const rings = patternShape(kind, 60, 40, cell, web).layers[0].rings;
        expect(rings.length, `${kind} ${cell}/${web}`).toBeGreaterThan(1);
        expect(minGap(rings), `${kind} ${cell}/${web}`).toBeGreaterThanOrEqual(web - 0.05);
      }
  });

  it('warns when the dovetail overhang is steeper than 45 degrees', () => {
    const steep = setup('sliding', { wall: 4, grooveDepth: 3.2, slideLid: 1.6 });
    expect(steep.warnings.some((w) => /steeper than 45/.test(w.text))).toBe(true);
    expect(steep.t.parts(steep.p, steep.R)[0].tip).toMatch(/supports/);
    expect(setup('sliding').warnings.some((w) => /steeper than 45/.test(w.text))).toBe(false);
  });

  it('a lid that is all thumb grip has no graphics face, and an empty outline never means "no clipping"', () => {
    const s = setup('sliding', { width: 30, depth: 14, wall: 1.2, grooveDepth: 0.6, slideLid: 1.6 });
    for (const f of s.faces()) if (f.id === 'lid-top') expect(Math.abs(signedArea(f.outline))).toBeGreaterThanOrEqual(20);
    const solids = s.build();
    const face = { ...s.faces().find((f) => f.id === 'bottom')!, outline: [] as Vec2[] };
    const out = applyGraphics(solids, [face], [placeGraphic({ id: 'g', faceId: 'bottom', source: { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0 }, x: 0, y: 0, w: 60, h: 60, lockAspect: true, rotation: 0, mirror: false, mode: 'emboss', depth: 1, color: '#ffffff', lithoMin: 0.8, lithoMax: 3, hidden: false }, builtinShape('star', 5, 0.45, 0))]);
    expect(out.solids.base.volume()).toBeCloseTo(solids.base.volume(), 3);
    expect(out.warnings.some((w) => /no room/.test(w.text))).toBe(true);
  });

  for (const threadClearance of [0.1, 0.25]) {
    it(`fine jar threads keep clearance on both flanks (pitch 1.5, clearance ${threadClearance})`, () => {
      const s = setup('jar', { threadPitch: 1.5, threadDepth: 3, threadClearance });
      const { jar, cap } = s.build();
      const pitch = s.R.pitch as number;
      for (const turn of [0, 0.02, 0.05, 0.1, 0.25]) {
        // Unscrewing (right-hand thread): turn anticlockwise about +Z while rising one pitch per turn.
        const moved = cap.rotate([0, 0, turn * 360]).translate([0, 0, turn * pitch]);
        expect(overlap(jar, moved), `turn ${turn}`).toBeLessThan(0.01);
      }
    });
  }

  it('a thin-walled jar keeps its cap in one piece (knurling is skipped)', () => {
    for (const diameter of [20, 80, 160]) {
      const r = runBuild({ id: 1, type: 'jar', params: { ...DEFAULT_PARAMS, diameter, wall: 0.8, grip: 'knurl' }, graphics: [], quality: 'fine' });
      expect(r.warnings.filter((w) => /pieces|no solid/.test(w.text)), `d ${diameter}`).toEqual([]);
      expect(r.parts.map((p) => p.id).sort()).toEqual(['cap', 'jar']);
    }
  });

  it('jar sized from the inside gives an opening of the typed diameter', () => {
    const s = setup('jar', { dimsMode: 'inner', diameter: 80 });
    expect(2 * (s.R.rBore as number)).toBeCloseTo(80, 6);
    expect(s.R.inner[0]).toBeCloseTo(80, 6);
  });

  it('triangle polygon faces stay inside the rounded outline', () => {
    for (const lidStyle of ['plug', 'cap'] as const) {
      const s = setup('polygon', { sides: 3, diameter: 80, polyRound: 20, polyLid: true, lidStyle });
      const solids = s.build();
      for (const id of ['lid-top', 'bottom']) {
        const f = s.faces().find((x) => x.id === id)!;
        const part = solids[f.partId].boundingBox();
        const ys = f.outline.map((q) => q[1] * (id === 'bottom' ? -1 : 1) + f.origin[1]);
        const xs = f.outline.map((q) => q[0] + f.origin[0]);
        expect(Math.max(...ys), `${lidStyle} ${id}`).toBeLessThanOrEqual(part.max[1] + 0.01);
        expect(Math.min(...ys), `${lidStyle} ${id}`).toBeGreaterThanOrEqual(part.min[1] - 0.01);
        expect(Math.max(...xs), `${lidStyle} ${id}`).toBeLessThanOrEqual(part.max[0] + 0.01);
      }
    }
  });

  it('two different fonts uploaded under the same name stay separate', async () => {
    const read = (f: string) => new Uint8Array(readFileSync(new URL(`../public/fonts/${f}`, import.meta.url))).buffer;
    const a = await registerCustomFont(read('pacifico.woff'), 'Logo');
    const b = await registerCustomFont(read('bebas-neue.woff'), 'Logo');
    expect(a.id).not.toBe(b.id);
    expect(customFontName(a.id)).toBe('Logo');
    expect((await loadFont(a.id)).names).not.toEqual((await loadFont(b.id)).names);
  });

  it('project files get valid colours, and only photos stay lithophanes', () => {
    const p = normalizeProject({
      type: 'tray',
      color: 'red',
      graphics: [{ id: 'g', faceId: 'front', source: { kind: 'text', text: 'A', font: 'archivo-black', align: 'center', lineSpacing: 1, letterSpacing: 0 }, mode: 'lithophane', color: 'blue' }],
    });
    expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p.graphics[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p.graphics[0].mode).toBe('deboss');
  });
});

describe('review round 4', () => {
  const star = () => builtinShape('star', 5, 0.45, 0);
  const gfx = (over: Partial<Graphic>): Graphic => ({
    id: 'g', faceId: 'front', source: { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0 }, x: 0, y: 0, w: 20, h: 20,
    lockAspect: false, rotation: 0, mirror: false, mode: 'deboss', depth: 0.8, color: '#ff0000', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });
  /** A lithophane graphic with a dark-to-light ramp, as the build controller would place it. */
  const litho = (faceId: string, w: number, h: number, y = 0, max = 3) => {
    const pg = placeGraphic(gfx({ faceId, mode: 'lithophane', w, h, y, lithoMax: max }), builtinShape('rect', 4, 0.5, 0));
    const pw = 24, ph = 12;
    pg.litho = { pixels: Uint8Array.from({ length: pw * ph }, (_, i) => (i % pw) * 10), pw, ph, min: 0.8, max };
    return pg;
  };
  const partsOverlap = (solids: Record<string, Manifold>) => {
    const ids = Object.keys(solids);
    let worst = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) worst = Math.max(worst, overlap(solids[ids[i]], solids[ids[j]]));
    return worst;
  };

  const cases: [keyof typeof BOX_TYPES, Partial<BoxParams>, string][] = [
    ['lidded', { lidStyle: 'plug' }, 'front'],
    ['lidded', { lidStyle: 'cap' }, 'lid-front'],
    ['lidded', { lidStyle: 'rabbet', wall: 3 }, 'lid-front'],
    ['hinged', {}, 'front'],
    ['polygon', { polyLid: true, lidStyle: 'plug' }, 'side2'],
    ['drawers', {}, 'left'],
  ];
  for (const [type, over, faceId] of cases) {
    it(`a lithophane on ${type} ${faceId} ${JSON.stringify(over)} stays out of the mating parts`, () => {
      const s = setup(type, over);
      const faces = s.faces();
      const face = faces.find((f) => f.id === faceId)!;
      expect(face, faceId).toBeTruthy();
      const out = applyGraphics(s.build(), faces, [litho(faceId, Math.min(40, face.width - 4), Math.min(24, face.height - 2), face.height / 2 - Math.min(24, face.height - 2) / 2 - 1)]);
      expect(partsOverlap(out.solids)).toBeLessThan(0.01);
    });
  }

  it('an open tray still lets a lithophane reach past its wall', () => {
    const s = setup('tray');
    const solids = s.build();
    const out = applyGraphics(solids, s.faces(), [litho('front', 40, 20, 0, 4)]);
    // Material behind the 2 mm wall inside the window means the relief kept its full 4 mm.
    const inside = out.solids.base.intersect(box(-10, 10, -s.R.outer[1] / 2 + 2.2, -s.R.outer[1] / 2 + 3.9, 20, 28)).volume();
    expect(inside).toBeGreaterThan(1);
  });

  for (const [type, over] of [['lidded', { lidStyle: 'plug' }], ['hinged', {}], ['polygon', { polyLid: true, lidStyle: 'plug', sides: 4, polyRound: 0 }]] as const) {
    it(`inside size of ${type} ${JSON.stringify(over)} is usable space`, () => {
      const s = setup(type, { ...over, dimsMode: 'inner', width: 80, depth: 60, height: 40, diameter: 60, radius: 0 });
      const [iw, id, ih] = s.R.inner;
      expect(ih).toBeGreaterThanOrEqual(40 - 1e-6);
      const parts = s.build();
      // For the square polygon the inside is the square inscribed in the flats.
      const hw = type === 'polygon' ? iw / 2 / Math.SQRT2 : iw / 2, hd = type === 'polygon' ? id / 2 / Math.SQRT2 : id / 2;
      const block = box(-hw + 0.05, hw - 0.05, -hd + 0.05, hd - 0.05, s.p.floor + 0.01, s.p.floor + ih - 0.05);
      for (const [k, m] of Object.entries(parts)) expect(overlap(block, m), k).toBeLessThan(0.01);
    });
  }

  it('a slip-over cap must reach down over the box', () => {
    expect(setup('lidded', { lidStyle: 'cap', lidHeight: 2 }).errors.length).toBeGreaterThan(0);
    expect(setup('lidded', { lidStyle: 'cap', lidHeight: 3 }).errors.length).toBeGreaterThan(0);
    const short = setup('lidded', { lidStyle: 'cap', lidHeight: 4 });
    expect(short.errors).toEqual([]);
    expect(short.warnings.some((w) => /come off easily/.test(w.text))).toBe(true);
    expect(setup('polygon', { polyLid: true, lidStyle: 'cap', lidHeight: 1 }).errors.length).toBeGreaterThan(0);
  });

  it('a flush lid on walls too thin for its clearance is refused', () => {
    expect(setup('lidded', { lidStyle: 'rabbet', wall: 0.8, tolerance: 0.6 }).errors.length).toBeGreaterThan(0);
    expect(setup('lidded', { lidStyle: 'rabbet', wall: 1.2, tolerance: 1 }).errors.length).toBeGreaterThan(0);
    expect(setup('lidded', { lidStyle: 'rabbet', wall: 2 }).errors).toEqual([]);
  });

  it('inlay fills never plug through-cuts, overlap raised graphics, or overlap each other', () => {
    const s = setup('lidded');
    const faces = s.faces();
    const solids = s.build();
    const inlay = (color: string, x = 0) => placeGraphic(gfx({ mode: 'inlay', depth: 0.6, color, x, w: 30, h: 20, source: { kind: 'shape', shape: 'rect', sides: 4, ratio: 0.5, corner: 0 } }), builtinShape('rect', 4, 0.5, 0));
    const hole = placeGraphic(gfx({ mode: 'cut', w: 10, h: 10, source: { kind: 'shape', shape: 'circle', sides: 4, ratio: 0.5, corner: 0 } }), builtinShape('circle'));
    const raised = placeGraphic(gfx({ mode: 'emboss', depth: 1, x: 8 }), star());
    const whole = Object.values(applyGraphics(solids, faces, [inlay('#ff0000')]).inlays)[0].solid.volume();
    for (const order of [[inlay('#ff0000'), hole], [hole, inlay('#ff0000')]]) {
      const out = applyGraphics(solids, faces, order);
      const fill = Object.values(out.inlays)[0].solid;
      expect(overlap(fill, out.solids.base)).toBeLessThan(0.01);
      // The fill lost exactly the through-hole: a 10 mm circle, 0.6 mm deep.
      expect(whole - fill.volume()).toBeCloseTo(Math.PI * 25 * 0.6, 0);
    }
    const over = applyGraphics(solids, faces, [inlay('#ff0000'), raised]);
    expect(overlap(Object.values(over.inlays)[0].solid, over.solids.base)).toBeLessThan(0.01);
    const two = applyGraphics(solids, faces, [inlay('#ff0000'), inlay('#00ff00', 10)]);
    const [a, b] = Object.values(two.inlays).map((x) => x.solid);
    expect(overlap(a, b)).toBeLessThan(0.01);
    for (const inl of Object.values(two.inlays)) for (const piece of inl.solid.decompose()) expect(piece.volume()).toBeGreaterThanOrEqual(0.02);
  });

  it('outline cache keys and font ids cover the whole file', () => {
    const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${'<path d="M0 0L10 10"/>'.repeat(400)}<path d="M5 5L${n} 9Z"/></svg>`;
    expect(sourceKey({ kind: 'svg', name: 'a', svg: svg(90) })).not.toBe(sourceKey({ kind: 'svg', name: 'a', svg: svg(30) }));
  });

  it('warns when a graphic sits on a face this box does not have', () => {
    const s = setup('tray');
    const out = applyGraphics(s.build(), s.faces(), [placeGraphic(gfx({ faceId: 'lid-top' }), star())]);
    expect(out.warnings.some((w) => /face this box does not have/.test(w.text))).toBe(true);
  });
});

describe('review round 5', () => {
  const gfx = (over: Partial<Graphic>): Graphic => ({
    id: 'g', faceId: 'front', source: { kind: 'shape', shape: 'rect', sides: 4, ratio: 0.5, corner: 0 }, x: 0, y: 0, w: 20, h: 10,
    lockAspect: false, rotation: 0, mirror: false, mode: 'deboss', depth: 0.8, color: '#ff0000', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });
  const rect = () => builtinShape('rect', 4, 0.5, 0);
  const litho = (faceId: string, frame: { x: number; y: number; w: number; h: number; rotation?: number }, max = 3) => {
    const pg = placeGraphic(gfx({ faceId, mode: 'lithophane', lithoMax: max, rotation: frame.rotation ?? 0, ...frame }), rect());
    const pw = 30, ph = 20;
    pg.litho = { pixels: Uint8Array.from({ length: pw * ph }, (_, i) => (i * 37) % 256), pw, ph, min: 0.8, max };
    return pg;
  };
  /** Deterministic pseudo-random numbers in [0, 1). */
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  it('lithophanes always fuse with their wall (no loose shell, no false warning)', () => {
    const rand = rng(7);
    const cases: [keyof typeof BOX_TYPES, Partial<BoxParams>, string][] = [
      ['tray', {}, 'front'], ['lidded', {}, 'lid-top'], ['lidded', {}, 'front'], ['jar', {}, 'front'], ['polygon', {}, 'side2'], ['hinged', {}, 'lid-top'],
    ];
    for (const [type, over, faceId] of cases) {
      const s = setup(type, over);
      const faces = s.faces();
      const solids = s.build();
      const face = faces.find((f) => f.id === faceId)!;
      for (let k = 0; k < 6; k++) {
        const w = 10 + rand() * (face.width * 0.7 - 10), h = 8 + rand() * (face.height * 0.7 - 8);
        const frame = { w, h, x: (rand() - 0.5) * (face.width - w) * 0.8, y: (rand() - 0.5) * (face.height - h) * 0.8 };
        const out = applyGraphics(solids, faces, [litho(faceId, frame)]);
        const part = out.solids[face.partId];
        expect(part.decompose().length, `${type} ${faceId} ${JSON.stringify(frame)}`).toBe(1);
        expect(out.warnings.some((x) => /loose pieces/.test(x.text)), `${type} ${faceId}`).toBe(false);
      }
    }
  });

  it('an inlay deeper than the wall stops flush with the inside', () => {
    for (const [type, faceId, y] of [['drawers', 'left', 0], ['lidded', 'front', 14], ['hinged', 'front', 12]] as const) {
      const s = setup(type);
      const solids = s.build();
      const out = applyGraphics(solids, s.faces(), [placeGraphic(gfx({ faceId, mode: 'inlay', depth: 3, w: 30, h: 8, y }), rect())]);
      const fill = Object.values(out.inlays)[0].solid;
      expect(fill.volume(), `${type}`).toBeGreaterThan(10);
      for (const [id, m] of Object.entries(out.solids)) expect(overlap(fill, m), `${type}: fill x ${id}`).toBeLessThan(0.01);
    }
  });

  /** Apply the "at least N mm" a refusal advises to `key`, and check the box is then accepted. */
  const followAdvice = (type: keyof typeof BOX_TYPES, over: Partial<BoxParams>, key: keyof BoxParams) => {
    const s = setup(type, over);
    expect(s.errors.length, JSON.stringify(over)).toBeGreaterThan(0);
    const m = /at least ([\d.]+) mm/.exec(s.errors[0].text);
    expect(m, s.errors[0].text).toBeTruthy();
    const after = setup(type, { ...over, [key]: Number(m![1]) });
    expect(after.errors.map((e) => e.text), `${key} = ${m![1]}`).toEqual([]);
  };

  it('refusals advise values that are then accepted', () => {
    followAdvice('hinged', { dimsMode: 'inner', height: 6, floor: 0.6, lipHeight: 1, knuckleDiameter: 20 }, 'height');
    followAdvice('hinged', { floor: 8.8, lidHeight: 118.2, height: 120 }, 'height');
    followAdvice('lidded', { lidStyle: 'cap', lidTop: 10, lidHeight: 5 }, 'lidHeight');
    followAdvice('lidded', { lidStyle: 'cap', lidTop: 2.2, lidHeight: 2.5 }, 'lidHeight');
    followAdvice('lidded', { lidStyle: 'rabbet', lidTop: 3, lidHeight: 3 }, 'lidHeight');
    followAdvice('lidded', { lidStyle: 'rabbet', wall: 1, tolerance: 0.4 }, 'wall');
    followAdvice('hinged', { knuckleDiameter: 10, lidHeight: 4.5, lidTop: 2 }, 'lidHeight');
    expect(setup('lidded', { lidStyle: 'rabbet', lipHeight: 0.5 }).errors[0].text).toMatch(/Lip depth/);
    // 12 mm across with 4 mm walls: even the thinnest (0.8 mm) lip leaves no room in the middle.
    const tiny = setup('lidded', { width: 12, depth: 12, lidStyle: 'plug', wall: 4, lipThickness: 0.8 });
    expect(tiny.errors[0].text).toMatch(/too small for a [\d.]+ mm lid lip/);
    expect(tiny.errors[0].text).not.toMatch(/at most 0 mm/);
  });

  it('lithophanes use the free space behind lid tops, jar bottoms and walls below a lip', () => {
    const limited = (type: keyof typeof BOX_TYPES, over: Partial<BoxParams>, faceId: string, frame: { x: number; y: number; w: number; h: number }) => {
      const s = setup(type, over);
      const out = applyGraphics(s.build(), s.faces(), [litho(faceId, frame, 5)]);
      return out.warnings.some((x) => /is limited to/.test(x.text));
    };
    expect(limited('lidded', { lidStyle: 'plug' }, 'lid-top', { x: 0, y: 0, w: 40, h: 30 })).toBe(false);
    expect(limited('hinged', {}, 'lid-top', { x: 0, y: 0, w: 40, h: 30 })).toBe(false);
    expect(limited('jar', {}, 'bottom', { x: 0, y: 0, w: 30, h: 30 })).toBe(false);
    expect(limited('hinged', { height: 60 }, 'back', { x: 0, y: 0, w: 30, h: 10 })).toBe(false);
    // Low on a plug-lid box's front there is room; up where the lip comes down there is not.
    expect(limited('lidded', { lidStyle: 'plug' }, 'front', { x: 0, y: -8, w: 30, h: 10 })).toBe(false);
    expect(limited('lidded', { lidStyle: 'plug' }, 'front', { x: 0, y: 12, w: 30, h: 10 })).toBe(true);
    expect(limited('lidded', { lidStyle: 'cap' }, 'lid-top', { x: 0, y: 0, w: 40, h: 30 })).toBe(true);
  });

  it('warns when a raised graphic on a side wall is tall enough to need supports', () => {
    const raised = (type: keyof typeof BOX_TYPES, faceId: string, depth: number) => {
      const r = runBuild({ id: 1, type, params: { ...DEFAULT_PARAMS }, graphics: [placeGraphic(gfx({ faceId, mode: 'emboss', depth, w: 30, h: 6 }), rect())], quality: 'fine' });
      return r.warnings.some((x) => /needs supports/.test(x.text));
    };
    expect(raised('tray', 'front', 3)).toBe(true);
    expect(raised('tray', 'front', 1.5)).toBe(false);
    expect(raised('gridfinity', 'label', 0.9)).toBe(false);
    expect(raised('sliding', 'lid-top', 4)).toBe(false);
  });

  it('Gridfinity inside height is full-width space below the stacking lip', () => {
    const s = setup('gridfinity', { gfLip: true, gfWall: 1.2, gfZ: 4 });
    expect(s.R.inner[2]).toBeCloseTo(18.4, 6);
    expect(setup('gridfinity', { gfLip: false, gfZ: 4 }).R.inner[2]).toBeCloseTo(21, 6);
  });
});

describe('review round 6', () => {
  const gfx = (over: Partial<Graphic>): Graphic => ({
    id: 'g', faceId: 'front', source: { kind: 'shape', shape: 'rect', sides: 4, ratio: 0.5, corner: 0 }, x: 0, y: 0, w: 20, h: 10,
    lockAspect: false, rotation: 0, mirror: false, mode: 'deboss', depth: 0.8, color: '#ff0000', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });
  const rect = () => builtinShape('rect', 4, 0.5, 0);
  const litho = (faceId: string, frame: { x: number; y: number; w: number; h: number }, max = 3, dark = false) => {
    const pg = placeGraphic(gfx({ faceId, mode: 'lithophane', lithoMax: max, ...frame }), rect());
    const pw = 30, ph = 20;
    pg.litho = { pixels: Uint8Array.from({ length: pw * ph }, (_, i) => (dark ? 0 : (i * 37) % 256)), pw, ph, min: 0.8, max };
    return pg;
  };

  for (const type of BOX_ORDER) {
    it(`a lithophane just touching the edge of a ${type} face leaves the part whole`, () => {
      const s = setup(type);
      const faces = s.faces();
      const solids = s.build();
      const face = faces.find((f) => f.kind === 'plane' && f.id !== 'bottom' && !f.solid && f.outline.length >= 3)!;
      for (const overlapBy of [0.01, 0.03, 0.05]) {
        const out = applyGraphics(solids, faces, [litho(face.id, { x: -face.width / 2 - 15 + overlapBy, y: 0, w: 30, h: 8 })]);
        const before = solids[face.partId].volume(), after = out.solids[face.partId].volume();
        expect(Math.abs(after - before), `${type} ${face.id} overlap ${overlapBy}`).toBeLessThan(5);
        expect(out.solids[face.partId].status()).toBe('NoError');
      }
    });
  }

  it('a small photo in the hinged finger notch leaves the box whole', () => {
    const s = setup('hinged');
    const solids = s.build();
    const front = s.faces().find((f) => f.id === 'front')!;
    const out = applyGraphics(solids, s.faces(), [litho('front', { x: 0, y: front.height / 2 - 4, w: 12, h: 8 })]);
    expect(out.solids.base.volume()).toBeGreaterThan(solids.base.volume() * 0.95);
  });

  const shortBoxes: [keyof typeof BOX_TYPES, Partial<BoxParams>][] = [
    ['lidded', { lidStyle: 'rabbet', height: 14, lidHeight: 8 }],
    ['hinged', { alignLip: false, height: 16, lidHeight: 10, knuckleDiameter: 4 }],
    ['polygon', { polyLid: true, lidStyle: 'rabbet', height: 14, lidHeight: 8 }],
    ['jar', { height: 20, threadLength: 3 }],
  ];
  for (const [type, over] of shortBoxes) {
    it(`a thick lithophane in the bottom of a short ${type} stays clear of the lid`, () => {
      const s = setup(type, over);
      expect(s.errors).toEqual([]);
      const solids = s.build();
      const bottom = s.faces().find((f) => f.id === 'bottom')!;
      const out = applyGraphics(solids, s.faces(), [litho('bottom', { x: 0, y: 0, w: bottom.width * 0.9, h: bottom.height * 0.9 }, 8, true)]);
      const ids = Object.keys(out.solids);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlap(out.solids[ids[i]], out.solids[ids[j]]), `${ids[i]} x ${ids[j]}`).toBeLessThan(0.01);
    });
  }

  it('engravings, inlays and cut-outs on top of a raised graphic go through it', () => {
    const s = setup('tray');
    const faces = s.faces();
    const solids = s.build();
    const plaque = placeGraphic(gfx({ mode: 'emboss', depth: 1, w: 50, h: 20 }), rect());
    const dot = (mode: Graphic['mode']) => placeGraphic(gfx({ mode, depth: 0.6, w: 10, h: 10, source: { kind: 'shape', shape: 'circle', sides: 4, ratio: 0.5, corner: 0 } }), builtinShape('circle'));
    const alone = applyGraphics(solids, faces, [plaque]).solids.base.volume();
    // Depth counts from the plaque's surface: a 0.6 mm engraving takes 0.6 mm out of the plaque.
    const engraved = applyGraphics(solids, faces, [plaque, dot('deboss')]);
    expect(alone - engraved.solids.base.volume()).toBeCloseTo(Math.PI * 25 * 0.6, 0);
    // The inlay colour fills that pocket right up to the plaque's surface.
    const inlaid = applyGraphics(solids, faces, [plaque, dot('inlay')]);
    const fill = Object.values(inlaid.inlays)[0].solid;
    expect(fill.volume()).toBeCloseTo(Math.PI * 25 * 0.6, 0);
    expect(fill.boundingBox().min[1]).toBeCloseTo(-s.R.outer[1] / 2 - 1, 3);
    const cut = applyGraphics(solids, faces, [plaque, dot('cut')]);
    const D = s.R.outer[1];
    expect(cut.solids.base.intersect(box(-1, 1, -D / 2 - 2, -D / 2 + 2, s.R.outer[2] / 2 - 1, s.R.outer[2] / 2 + 1)).volume()).toBeLessThan(0.01);
  });

  it('warns when a lithophane ledges more than 2 mm into the box on a side wall', () => {
    const s = setup('tray');
    const warns = (max: number) => applyGraphics(s.build(), s.faces(), [litho('front', { x: 0, y: 0, w: 40, h: 30 }, max, true)], { base: BOX_TYPES.tray.parts(s.p, s.R)[0].print }).warnings;
    expect(warns(6).some((w) => /ledge needs supports/.test(w.text))).toBe(true);
    expect(warns(3.5).some((w) => /ledge needs supports/.test(w.text))).toBe(false);
  });

  it('a lithophane on a triangular box never pokes out of the box', () => {
    for (const polyRound of [0, 1.5]) {
      const s = setup('polygon', { sides: 3, polyLid: false, polyRound });
      const solids = s.build();
      const side = s.faces().find((f) => f.id === 'front')!;
      const out = applyGraphics(solids, s.faces(), [litho('front', { x: 0, y: 0, w: side.width * 0.95, h: side.height * 0.8 }, 8, true)]);
      expect(out.solids.base.subtract(solids.base.hull()).volume(), `rounding ${polyRound}`).toBeLessThan(0.01);
    }
  });

  it('a Gridfinity bin with dividers still lets the next bin seat fully', () => {
    const s = setup('gridfinity', { gfDividersX: 3, gfLabel: false, gfLip: true });
    const { bin } = s.build();
    const plain = setup('gridfinity', { gfDividersX: 1, gfLabel: false, gfLip: true }).build().bin;
    expect(overlap(plain.translate([0, 0, (s.R.Hbody as number) - 0.34]), bin)).toBeLessThan(0.01);
    const label = setup('gridfinity', { gfLabel: true, gfLip: true });
    const raised = (depth: number) =>
      applyGraphics(label.build(), label.faces(), [placeGraphic(gfx({ faceId: 'label', mode: 'emboss', depth, w: 20, h: 6 }), rect())]).warnings.some((w) => /stacked on top/.test(w.text));
    expect(raised(0.8)).toBe(false);
    expect(raised(0.9)).toBe(true);
  });

  it('"make it at least N mm across" uses the current lip and is then accepted', () => {
    for (const [type, over] of [['lidded', { width: 10, depth: 10, wall: 4, tolerance: 0.2, lipThickness: 3, lidStyle: 'plug' }], ['hinged', { width: 10, depth: 10, wall: 4, tolerance: 0.2, lipThickness: 3 }]] as const) {
      const s = setup(type, over as Partial<BoxParams>);
      const m = /at least ([\d.]+) mm across/.exec(s.errors[0]?.text ?? '');
      expect(m, s.errors[0]?.text).toBeTruthy();
      const size = Number(m![1]);
      expect(setup(type, { ...(over as Partial<BoxParams>), width: size, depth: size }).errors.filter((e) => /lip/.test(e.text))).toEqual([]);
    }
  });

  it('inch nudges stay close to the millimetre step', () => {
    expect(lengthProps('in', 0.05).step).toBeCloseTo(0.002, 6);
    expect(lengthProps('in', 0.1).step).toBeCloseTo(0.004, 6);
    expect(lengthProps('in', 1).step).toBe(0.05);
  });
});

describe('review round 7', () => {
  it('a part that only fits the bed turned 90 degrees is turned, not called too big', () => {
    const bed = PRINTERS.find((b) => b.id === 'bed250')!;
    const part = (id: string, w: number, d: number, h = 30) =>
      ({ id, name: id, role: 'body', print: IDENTITY, printMin: [-w / 2, -d / 2, 0], printMax: [w / 2, d / 2, h] }) as unknown as PartMesh;
    for (const parts of [[part('Tray', 150, 230)], [part('Box', 120, 225), part('Lid', 120, 225, 12)], [part('Wide', 230, 150)]]) {
      const L = layoutParts(parts, bed);
      expect(L.overflow, parts.map((p) => p.name).join()).toEqual(parts.length > 1 ? ['the parts together'] : []);
      for (const p of parts) {
        const m = L.matrices.get(p.id)!;
        const corners = [0, 1, 2, 3].map((k) => applyMat(m, [k & 1 ? p.printMax[0] : p.printMin[0], k & 2 ? p.printMax[1] : p.printMin[1], 0]));
        for (const [x, y] of corners) {
          expect(Math.abs(x), `${p.name} x`).toBeLessThanOrEqual(bed.w / 2 + 0.01);
          if (parts.length === 1) expect(Math.abs(y), `${p.name} y`).toBeLessThanOrEqual(bed.d / 2 + 0.01);
        }
      }
    }
    // A part too big either way is still reported.
    expect(layoutParts([part('Huge', 260, 260)], bed).overflow).toEqual(['Huge']);
  });
});

describe('review round 8', () => {
  const gfx = (over: Partial<Graphic>): Graphic => ({
    id: 'g', faceId: 'front', source: { kind: 'shape', shape: 'rect', sides: 5, ratio: 0.45, corner: 0 }, x: 0, y: 0, w: 30, h: 20,
    lockAspect: false, rotation: 0, mirror: false, mode: 'inlay', depth: 0.6, color: '#ff0000', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });
  const shape = (s: 'rect' | 'circle' | 'star' | 'plus', over: Partial<Graphic>, ratio = 0.45, corner = 0) =>
    placeGraphic(gfx({ source: { kind: 'shape', shape: s, sides: 5, ratio, corner }, ...over }), builtinShape(s, 5, ratio, corner));
  /** The rounded shapes of the random sweeps these cases came from. */
  const swept = (s: 'rect' | 'circle' | 'star' | 'plus', over: Partial<Graphic>) => shape(s, over, 0.5, 0.1);
  const totalFill = (out: { inlays: Record<string, { solid: Manifold }> }) => Object.values(out.inlays).reduce((s, i) => s + i.solid.volume(), 0);
  /** Material in a 0.2 mm cube at face point (u, v, w), w measured out from the face. */
  const solidAt = (m: Manifold, face: FaceDef, u: number, v: number, w: number) =>
    overlap(m, transformed(box(u - 0.1, u + 0.1, v - 0.1, v + 0.1, w - 0.1, w + 0.1), frameMatrix(face.u, face.v, face.n, face.origin))) > 0.004;

  it('a later inlay over an earlier inlay or engraving colours its whole pocket', () => {
    const s = setup('tray');
    const faces = s.faces();
    const solids = s.build();
    const removed = (out: ReturnType<typeof applyGraphics>) => solids.base.volume() - out.solids.base.volume();
    for (const color of ['#00ff00', '#ff0000']) {
      const two = applyGraphics(solids, faces, [shape('rect', {}), shape('rect', { id: 'g2', x: 10, color })]);
      // Two 30 x 20 mm pockets 0.6 mm deep, overlapping by 20 x 20 mm.
      expect(removed(two)).toBeCloseTo(480, 0);
      expect(totalFill(two), color).toBeCloseTo(480, 0);
    }
    const engraved = applyGraphics(solids, faces, [shape('rect', { mode: 'deboss', depth: 0.5, x: 10 }), shape('rect', {})]);
    expect(totalFill(engraved)).toBeCloseTo(360, 0);
    // White letters inlaid on a red disc keep their colour.
    const letters = shape('star', { id: 'g2', w: 16, h: 16, color: '#ffffff' });
    const badge = applyGraphics(solids, faces, [shape('circle', { w: 40, h: 30, depth: 0.8 }), letters]);
    const alone = applyGraphics(solids, faces, [letters]).inlays['base::#ffffff'].solid.volume();
    expect(badge.inlays['base::#ffffff'].solid.volume()).toBeCloseTo(alone, 1);
    expect(totalFill(badge)).toBeCloseTo(removed(badge), 0);
  });

  it('raised graphics stand on a raised graphic under them', () => {
    const s = setup('tray');
    const faces = s.faces();
    const front = faces.find((f) => f.id === 'front')!;
    const solids = s.build();
    const plaque = shape('rect', { mode: 'emboss', depth: 2, w: 50, h: 20 });
    const star = shape('star', { id: 'g2', mode: 'emboss', depth: 1, w: 12, h: 12 });
    const onWall = applyGraphics(solids, faces, [star]).solids.base.volume() - solids.base.volume();
    const plain = applyGraphics(solids, faces, [plaque]).solids.base.volume();
    const both = applyGraphics(solids, faces, [plaque, star]);
    expect(both.solids.base.volume() - plain).toBeCloseTo(onWall, 0);
    expect(solidAt(both.solids.base, front, 0, 0, 2.5)).toBe(true);
    expect(solidAt(both.solids.base, front, 0, 0, 3.2)).toBe(false);
    // Limits on how far graphics stand proud count the plaque too.
    const bin = setup('gridfinity', { gfLabel: false });
    const proud = (n: number) =>
      applyGraphics(bin.build(), bin.faces(), [...Array(n)].map((_, i) => shape('rect', { id: `p${i}`, mode: 'emboss', depth: 0.2, w: 20 - 5 * i, h: 8 }))).warnings.some((w) => /stand 0\.4 mm proud/.test(w.text));
    expect(proud(1)).toBe(false);
    expect(proud(2)).toBe(true);
  });

  it('a deep mark on a plaque warns about the wall only when it really goes through', () => {
    const s = setup('tray');
    const faces = s.faces();
    const t = faces.find((f) => f.id === 'front')!.thickness;
    const solids = s.build();
    const plaque = shape('rect', { mode: 'emboss', depth: 2, w: 50, h: 20 });
    const through = (onPlaque: boolean, mode: Graphic['mode'], depth: number) =>
      applyGraphics(solids, faces, [...(onPlaque ? [plaque] : []), shape('circle', { id: 'g2', mode, depth, w: 10, h: 10 })]).warnings.some((w) => /through the/.test(w.text));
    for (const mode of ['deboss', 'inlay'] as const) {
      expect(through(true, mode, t + 1), mode).toBe(false);
      expect(through(true, mode, t + 2), mode).toBe(true);
      expect(through(false, mode, t), mode).toBe(true);
    }
  });

  it('a lithophane or cut-through takes the plaque under it away', () => {
    const s = setup('tray');
    const faces = s.faces();
    const solids = s.build();
    const plaque = shape('rect', { mode: 'emboss', depth: 2, w: 50, h: 24 });
    const photo = placeGraphic(gfx({ id: 'l', mode: 'lithophane', w: 20, h: 14 }), builtinShape('rect', 4, 0.5, 0));
    const pw = 24, ph = 12;
    photo.litho = { pixels: Uint8Array.from({ length: pw * ph }, (_, i) => (i % pw) * 10), pw, ph, min: 0.8, max: 2 };
    // An inlay on the photo counts its depth from the photo's surface, where the plaque was.
    const dot = shape('circle', { id: 'g2', w: 6, h: 6, depth: 0.6 });
    const out = applyGraphics(solids, faces, [plaque, photo, dot]);
    expect(Object.values(out.inlays)[0].solid.volume()).toBeCloseTo(Math.PI * 9 * 0.6, 0);
    // A raised dot on a cut-through plaque stands on the wall, not on the plaque that was cut away.
    const ring = shape('circle', { id: 'c', mode: 'cut', w: 12, h: 12 });
    const bump = shape('circle', { id: 'g3', mode: 'emboss', depth: 1, w: 16, h: 16 });
    const front = faces.find((f) => f.id === 'front')!;
    const cut = applyGraphics(solids, faces, [plaque, ring, bump]);
    expect(solidAt(cut.solids.base, front, 7.5, 0, 0.5)).toBe(true);
    expect(solidAt(cut.solids.base, front, 7.5, 0, 2.5)).toBe(true);
    expect(solidAt(cut.solids.base, front, 0, 0, 1.5)).toBe(false);
  });

  it('colour stays inside the part where a mark crosses the edges of stacked plaques', () => {
    const s = setup('hinged');
    const faces = s.faces();
    const solids = s.build();
    const plaques = [
      swept('circle', { faceId: 'bottom', mode: 'emboss', depth: 2.71, w: 36.89, h: 34.41, x: -15.71, y: 1.55 }),
      swept('star', { id: 'g2', faceId: 'bottom', mode: 'emboss', depth: 2.51, w: 18.91, h: 44.48, x: 4.01, y: -9.49 }),
    ];
    const mark = swept('plus', { id: 'g3', faceId: 'bottom', depth: 1.06, w: 25.32, h: 9.21, x: 5.97, y: 0.92 });
    const envelope = applyGraphics(solids, faces, plaques).solids.base;
    const out = applyGraphics(solids, faces, [...plaques, mark]);
    const fill = Object.values(out.inlays)[0].solid;
    expect(fill.subtract(envelope).volume()).toBeLessThan(0.01);
    // ...and fills its whole pocket.
    expect(envelope.subtract(out.solids.base).subtract(fill).volume()).toBeLessThan(0.05);
  });

  it('colour and body stay apart even when the part was not evaluated before the graphics', () => {
    const s = setup('jar', { width: 104, depth: 75, height: 36, wall: 1.2 });
    const faces = s.faces();
    const on = (shp: 'rect' | 'star' | 'circle', over: Partial<Graphic>) => swept(shp, { faceId: 'bottom', ...over });
    const out = applyGraphics(s.build(), faces, [
      on('star', { mode: 'emboss', depth: 2.96, w: 37.13, h: 52.56, x: 6.95, y: -12.72, rotation: -18 }),
      on('rect', { id: 'g2', mode: 'emboss', depth: 0.46, w: 26.93, h: 50.92, x: 16.07, y: 9.76 }),
      on('rect', { id: 'g3', depth: 1.28, w: 23.77, h: 16.24, x: 24.24, y: 10.74 }),
    ]);
    const fill = Object.values(out.inlays)[0].solid;
    expect(overlap(fill, out.solids.jar)).toBeLessThan(0.05);
    expect(fill.volume() - fill.subtract(out.solids.jar).volume()).toBeLessThan(0.05);
  });

  it('inlay colour on the jar fills its pocket up to the curved wall where a mark crosses a plaque edge', () => {
    const s = setup('jar');
    const faces = s.faces();
    const solids = s.build();
    const plaque = shape('rect', { mode: 'emboss', depth: 1.5, w: 40, h: 20, x: -15 });
    for (const mark of [shape('rect', { id: 'g2', w: 30, h: 10, x: 10 }), shape('star', { id: 'g2', w: 24, h: 16, x: 8 })]) {
      const envelope = applyGraphics(solids, faces, [plaque]).solids.jar;
      const out = applyGraphics(solids, faces, [plaque, mark]);
      const fill = Object.values(out.inlays)[0].solid;
      expect(envelope.subtract(out.solids.jar).subtract(fill).volume()).toBeLessThan(0.05);
      expect(fill.subtract(envelope).volume()).toBeLessThan(0.05);
    }
  });

  it('parts that fit the bed side by side only when all are turned are turned', () => {
    const bed = PRINTERS.find((b) => b.id === 'bed250')!;
    const part = (id: string, w: number, d: number) =>
      ({ id, name: id, role: 'body', print: IDENTITY, printMin: [-w / 2, -d / 2, 0], printMax: [w / 2, d / 2, 30] }) as unknown as PartMesh;
    const parts = [part('Box', 200, 120), part('Lid', 200, 120)];
    const L = layoutParts(parts, bed);
    expect(L.overflow).toEqual([]);
    const spans = parts.map((p) => {
      const m = L.matrices.get(p.id)!;
      const xs: number[] = [], ys: number[] = [];
      for (let k = 0; k < 4; k++) {
        const [x, y] = applyMat(m, [k & 1 ? p.printMax[0] : p.printMin[0], k & 2 ? p.printMax[1] : p.printMin[1], 0]);
        expect(Math.abs(x)).toBeLessThanOrEqual(bed.w / 2 + 0.01);
        expect(Math.abs(y)).toBeLessThanOrEqual(bed.d / 2 + 0.01);
        xs.push(x);
        ys.push(y);
      }
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    const [a, b] = spans;
    expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true);
  });
});

describe('review round 9', () => {
  const gfx = (over: Partial<Graphic>): Graphic => ({
    id: 'g', faceId: 'front', source: { kind: 'shape', shape: 'rect', sides: 5, ratio: 0.5, corner: 0 }, x: 0, y: 0, w: 30, h: 20,
    lockAspect: false, rotation: 0, mirror: false, mode: 'inlay', depth: 0.6, color: '#ff0000', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  });
  type Shape = 'rect' | 'circle' | 'star' | 'ring' | 'moon';
  const shape = (s: Shape, over: Partial<Graphic>, corner = 0) =>
    placeGraphic(gfx({ source: { kind: 'shape', shape: s, sides: 5, ratio: 0.5, corner }, ...over }), builtinShape(s, 5, 0.5, corner));
  const photo = (over: Partial<Graphic>) => {
    const pg = placeGraphic(gfx({ mode: 'lithophane', ...over }), builtinShape('rect', 4, 0.5, 0));
    const pw = 24, ph = 16;
    pg.litho = { pixels: Uint8Array.from({ length: pw * ph }, (_, k) => ((k % pw) * 255) / (pw - 1)), pw, ph, min: 0.8, max: 2.5 };
    return pg;
  };
  /** Overlap measured with a union, which a boolean misjudging shared faces leaves alone. */
  const realOverlap = (a: Manifold, b: Manifold) => a.volume() + b.volume() - a.add(b).volume();

  it('dropping a speck keeps sealed voids, so colour buried under a raised plate never overlaps the body', () => {
    const s = setup('tray');
    const inlay = shape('rect', { w: 20, h: 10 });
    const plate = shape('rect', { id: 'p', mode: 'emboss', depth: 2, w: 30, h: 20 });
    // The middle of a 1 mm ring cut through a wall falls out as a speck.
    const tiny = shape('ring', { id: 't', faceId: 'left', mode: 'cut', w: 1, h: 1 });
    const out = applyGraphics(s.build(), s.faces(), [inlay, plate, tiny]);
    const fill = out.inlays['base::#ff0000'].solid;
    expect(out.solids.base.decompose().some((m) => m.volume() < -1)).toBe(true);
    expect(realOverlap(fill, out.solids.base)).toBeLessThan(0.01);
    expect(overlap(fill, out.solids.base)).toBeLessThan(0.01);
  });

  it('colour stays out of the body where pockets of one colour nearly meet on a raised ring', () => {
    const s = setup('drawers');
    const marks: [Graphic['mode'], Shape, number, number, number, number, number, number, string][] = [
      ['deboss', 'rect', 25.02, 19.51, 9.16, -4.07, 0, 1.22, '#0000ff'],
      ['deboss', 'star', 38.68, 15.91, 17.29, 9.61, -38, 0.22, '#ff0000'],
      ['emboss', 'ring', 36.2, 8.89, 15.79, -4.66, 0, 2.11, '#0000ff'],
      ['inlay', 'rect', 29.8, 18.56, 12.43, -8.86, 0, 1.75, '#00ff00'],
      ['inlay', 'moon', 34.99, 18.38, 20.54, 5.56, 0, 1.73, '#00ff00'],
    ];
    for (const corner of [0, 0.15]) {
      const gs = marks.map(([mode, shp, w, h, x, y, rotation, depth, color], i) => shape(shp, { id: `g${i}`, faceId: 'left', mode, w, h, x, y, rotation, depth, color }, corner));
      const out = applyGraphics(s.build(), s.faces(), gs);
      const fill = out.inlays['sleeve::#00ff00'].solid;
      expect(overlap(fill, out.solids.sleeve), `corner ${corner}`).toBeLessThan(0.01);
      expect(realOverlap(fill, out.solids.sleeve), `corner ${corner}`).toBeLessThan(0.01);
    }
  });

  it('stacked raised graphics on a side wall warn when their edges line up into a step over 2 mm', () => {
    const s = setup('tray');
    const solids = s.build();
    const prints = { base: BOX_TYPES.tray.parts(s.p, s.R)[0].print };
    const warns = (gs: ReturnType<typeof shape>[]) => applyGraphics(solids, s.faces(), gs, prints).warnings.some((w) => /needs supports/.test(w.text));
    const raised = (id: string, depth: number, over: Partial<Graphic> = {}) => shape('rect', { id, mode: 'emboss', depth, w: 30, h: 10, ...over });
    expect(warns([raised('a', 2.5)])).toBe(true);
    expect(warns([raised('a', 1), raised('b', 1), raised('c', 1)])).toBe(true);
    // A bar flush with the bottom edge of a plate.
    expect(warns([raised('a', 2, { h: 20 }), raised('b', 1.5, { h: 4, y: -8 })])).toBe(true);
    // A name well inside a plate: steps of 1.5 and 1 mm.
    expect(warns([raised('a', 1.5, { w: 50, h: 24 }), raised('b', 1, { w: 20, h: 8 })])).toBe(false);
  });

  it('a lithophane replaces exactly the colour under it, and takes a raised plate away across its whole window', () => {
    const s = setup('tray');
    const faces = s.faces();
    const front = faces.find((f) => f.id === 'front')!;
    const solids = s.build();
    // A deep inlay near the floor, then a photo over it: no empty pocket is left behind the photo.
    const low = -front.height / 2 + 3;
    const pic = photo({ id: 'l', w: 40, h: 10, y: low });
    const out = applyGraphics(solids, faces, [shape('rect', { depth: 3.5, w: 30, h: 4, y: low }), pic]);
    const ideal = applyGraphics(solids, faces, [pic]).solids.base;
    const fill = out.inlays['base::#ff0000']?.solid;
    const gap = ideal.subtract(out.solids.base);
    expect((fill ? gap.subtract(fill) : gap).volume()).toBeLessThan(0.05);
    // No fin of the plate stands just inside the window's edge.
    const onPlate = applyGraphics(solids, faces, [shape('rect', { id: 'p', mode: 'emboss', depth: 2, w: 50, h: 24 }), photo({ id: 'l2', w: 20, h: 14 })]).solids.base;
    const band = transformed(box(9.95, 9.999, -5, 5, 0.2, 1.9), frameMatrix(front.u, front.v, front.n, front.origin));
    expect(overlap(onPlate, band)).toBeLessThan(0.01);
  });

  it('parts that fit the bed only with some turned and others not are laid out that way', () => {
    const bed = PRINTERS.find((b) => b.id === 'bed300')!;
    const part = (id: string, w: number, d: number) =>
      ({ id, name: id, role: 'body', print: IDENTITY, printMin: [-w / 2, -d / 2, 0], printMax: [w / 2, d / 2, 30] }) as unknown as PartMesh;
    const parts = [part('A', 205, 104), part('B', 206, 124), part('C', 183, 76)];
    const L = layoutParts(parts, bed);
    expect(L.overflow).toEqual([]);
    const spans = parts.map((p) => {
      const m = L.matrices.get(p.id)!;
      const pts = [0, 1, 2, 3].map((k) => applyMat(m, [k & 1 ? p.printMax[0] : p.printMin[0], k & 2 ? p.printMax[1] : p.printMin[1], 0]));
      for (const [x, y] of pts) {
        expect(Math.abs(x)).toBeLessThanOrEqual(bed.w / 2 + 0.01);
        expect(Math.abs(y)).toBeLessThanOrEqual(bed.d / 2 + 0.01);
      }
      return { x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), y1: Math.max(...pts.map((q) => q[1])) };
    });
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) {
        const [a, b] = [spans[i], spans[j]];
        expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0, `${i} ${j}`).toBe(true);
      }
  });
});
