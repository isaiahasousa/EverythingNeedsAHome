import { beforeAll, describe, expect, it } from 'vitest';
import { BOX_TYPES, DEFAULT_PARAMS } from '../src/boxes';
import { runBuild } from '../src/geometry/build';
import { applyGraphics } from '../src/geometry/graphics3d';
import { releaseAll } from '../src/geometry/kernel';
import { placeGraphic } from '../src/graphics/shape2d';
import { builtinShape, patternShape } from '../src/graphics/shapes';
import { traceField } from '../src/graphics/raster';
import type { BoxParams, Graphic, PlacedGraphic } from '../src/core/types';
import { loadKernel } from './setup-kernel';

beforeAll(loadKernel);

function graphic(over: Partial<Graphic>): Graphic {
  return {
    id: 'g1', faceId: 'front', source: { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0 },
    x: 0, y: 0, w: 30, h: 30, lockAspect: true, rotation: 0, mirror: false, mode: 'emboss', depth: 1,
    color: '#d0402b', lithoMin: 0.8, lithoMax: 3, hidden: false, ...over,
  };
}

function setup(type: keyof typeof BOX_TYPES, over: Partial<BoxParams> = {}) {
  const t = BOX_TYPES[type];
  const p = { ...DEFAULT_PARAMS, ...over } as BoxParams;
  const R = t.resolve(p);
  return { t, p, R, faces: t.faces(p, R), solids: t.build(p, R) };
}

describe('graphics on faces', () => {
  it('emboss / deboss / cut change volume as expected', () => {
    const { faces, solids } = setup('tray');
    const v0 = solids.base.volume();
    const star = builtinShape('star', 5, 0.45, 0);
    for (const [mode, sign] of [['emboss', 1], ['deboss', -1], ['cut', -1]] as const) {
      const pg = placeGraphic(graphic({ mode }), star);
      const out = applyGraphics(solids, faces, [pg]);
      const v = out.solids.base.volume();
      expect(out.solids.base.status()).toBe('NoError');
      expect(Math.sign(v - v0)).toBe(sign);
      expect(out.colorIds.size).toBe(1);
    }
    releaseAll();
  });

  it('inlay produces a separate body that exactly fills the pocket', () => {
    const { faces, solids } = setup('lidded');
    const pg = placeGraphic(graphic({ faceId: 'lid-top', mode: 'inlay', depth: 0.6, w: 40, h: 40 }), builtinShape('heart'));
    const out = applyGraphics(solids, faces, [pg]);
    const inlays = Object.values(out.inlays);
    expect(inlays.length).toBe(1);
    const fill = inlays[0].solid;
    expect(fill.volume()).toBeGreaterThan(100);
    expect(out.solids.lid.volume() + fill.volume()).toBeCloseTo(solids.lid.volume(), 0);
    expect(fill.intersect(out.solids.lid).volume()).toBeLessThan(0.01);
    releaseAll();
  });

  it('honeycomb vent cuts through', () => {
    const { faces, solids } = setup('tray');
    const g = graphic({ faceId: 'left', mode: 'cut', w: 40, h: 25, source: { kind: 'pattern', pattern: 'hex', cell: 5, web: 1.6 } });
    const shape = patternShape('hex', 40, 25, 5, 1.6);
    expect(shape.layers[0].rings.length).toBeGreaterThan(10);
    const out = applyGraphics(solids, faces, [placeGraphic(g, shape)]);
    expect(out.solids.base.status()).toBe('NoError');
    expect(out.solids.base.genus()).toBeGreaterThan(10);
    releaseAll();
  });

  it('wraps around the jar body', () => {
    const { faces, solids } = setup('jar');
    const shape = builtinShape('rect', 6, 0.5, 0);
    const v0 = solids.jar.volume();
    const wide = graphic({ faceId: 'front', w: 120, h: 20, lockAspect: false, depth: 1 });
    const out = applyGraphics(solids, faces, [placeGraphic(wide, shape)]);
    const added = out.solids.jar.volume() - v0;
    // A 120 x 20 band raised 1 mm on an r=40 cylinder: area * depth * (1 + depth / 2r).
    expect(added).toBeGreaterThan(120 * 20 * 1 * 0.97);
    expect(added).toBeLessThan(120 * 20 * 1.02 * 1.03);
    expect(out.solids.jar.status()).toBe('NoError');
    const bb = out.solids.jar.boundingBox();
    expect(bb.max[0]).toBeGreaterThan(40.5); // wrapped past the side, not a flat plate
    releaseAll();
  });

  it('builds a lithophane window', () => {
    const { faces, solids } = setup('tray', { width: 100, height: 70 });
    const pw = 40, ph = 30;
    const pixels = new Uint8Array(pw * ph);
    for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) pixels[j * pw + i] = Math.round((i / (pw - 1)) * 255);
    const g = graphic({ mode: 'lithophane', w: 60, h: 45 });
    const pg: PlacedGraphic = { ...placeGraphic(g, builtinShape('rect')), litho: { pixels, pw, ph, min: 0.8, max: 3 } };
    const out = applyGraphics(solids, faces, [pg]);
    expect(out.solids.base.status()).toBe('NoError');
    // Window removes 60x45x2 of wall; relief averages (0.8+3)/2 thick.
    const expected = solids.base.volume() - 60 * 45 * 2 + 60 * 45 * 1.9;
    expect(out.solids.base.volume()).toBeCloseTo(expected, -2);
    releaseAll();
  });

  it('end-to-end build returns coloured groups', () => {
    const type = 'lidded';
    const p = { ...DEFAULT_PARAMS } as BoxParams;
    const g1 = placeGraphic(graphic({ faceId: 'front', mode: 'deboss', w: 40, h: 20, lockAspect: false }), builtinShape('rect'));
    const g2 = placeGraphic(graphic({ id: 'g2', faceId: 'lid-top', mode: 'inlay', color: '#2255ff', w: 30, h: 30 }), builtinShape('circle'));
    const res = runBuild({ id: 1, type, params: p, graphics: [g1, g2], quality: 'fine' });
    expect(res.parts.map((x) => x.id)).toEqual(['base', 'lid', 'inlay-lid2255ff']);
    const base = res.parts[0];
    expect(base.groups.length).toBe(2);
    expect(base.materials).toEqual([null, '#d0402b']);
    expect(base.groups.reduce((s, g) => s + g.count, 0)).toBe(base.indices.length);
    expect(res.parts[2].role).toBe('inlay');
    expect(res.parts[1].printMax[2] - res.parts[1].printMin[2]).toBeCloseTo(12 + 6, 0); // lid height + plug lip
    console.log('end-to-end ms', res.ms.toFixed(0), 'tris', res.parts.map((x) => x.triangles));
  });
});

describe('image tracing', () => {
  it('traces a ring with a hole as two even-odd contours', () => {
    const w = 64, h = 64;
    const gray = new Uint8Array(w * h).fill(255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 32, y - 32);
        if (r < 24 && r > 12) gray[y * w + x] = 0;
      }
    const rings = traceField(gray, w, h, 128, false);
    expect(rings.length).toBe(2);
    const inverted = traceField(gray, w, h, 128, true);
    expect(inverted.length).toBe(3); // image border, the ring's outer edge, and the inner disc
  });
});
