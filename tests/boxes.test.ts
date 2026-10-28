import { beforeAll, describe, expect, it } from 'vitest';
import { BOX_ORDER, BOX_TYPES, DEFAULT_PARAMS } from '../src/boxes';
import { K, releaseAll } from '../src/geometry/kernel';
import type { BoxParams } from '../src/core/types';
import { loadKernel } from './setup-kernel';

beforeAll(loadKernel);

function buildType(id: keyof typeof BOX_TYPES, over: Partial<BoxParams> = {}) {
  const t = BOX_TYPES[id];
  const p = { ...DEFAULT_PARAMS, ...over } as BoxParams;
  const R = t.resolve(p);
  const parts = t.build(p, R);
  return { t, p, R, parts };
}

function overlap(a: any, b: any) {
  return a.intersect(b).volume();
}

describe('every box type builds valid solids', () => {
  for (const id of BOX_ORDER) {
    it(id, () => {
      const t0 = performance.now();
      const { t, p, R, parts } = buildType(id);
      const infos = t.parts(p, R);
      for (const info of infos) {
        const m = parts[info.id];
        expect(m, `${id}/${info.id} missing`).toBeTruthy();
        expect(m.status()).toBe('NoError');
        expect(m.volume()).toBeGreaterThan(100);
        expect(m.isEmpty()).toBe(false);
        expect(m.decompose().length, `${id}/${info.id} is in pieces`).toBe(1);
      }
      const faces = t.faces(p, R);
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        expect(infos.some((i) => i.id === f.partId), `face ${f.id} part ${f.partId}`).toBe(true);
        expect(f.width).toBeGreaterThan(0);
        expect(f.height).toBeGreaterThan(0);
      }
      const ids = Object.keys(parts);
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const v = overlap(parts[ids[i]], parts[ids[j]]);
          expect(v, `${id}: ${ids[i]} intersects ${ids[j]} by ${v.toFixed(3)} mm3`).toBeLessThan(0.01);
        }
      console.log(id, Object.fromEntries(ids.map((k) => [k, Math.round(parts[k].volume())])), `${(performance.now() - t0).toFixed(0)} ms`);
      releaseAll();
    });
  }
});

describe('variants', () => {
  const cases: [keyof typeof BOX_TYPES, Partial<BoxParams>][] = [
    ['tray', { dividersX: 3, dividersY: 2, radius: 0 }],
    ['tray', { dimsMode: 'inner', radius: 12 }],
    ['lidded', { lidStyle: 'rabbet', wall: 3, lipThickness: 1.4 }],
    ['lidded', { lidStyle: 'cap' }],
    ['lidded', { snap: true }],
    ['lidded', { lidHeight: 2, lidTop: 2 }],
    ['sliding', { radius: 0, thumbGrip: false }],
    ['hinged', { printedPin: true, knuckles: 7, alignLip: false }],
    ['drawers', { drawerCount: 1, drawerPull: 'notch', closedBack: false }],
    ['drawers', { drawerCount: 5, height: 120 }],
    ['polygon', { sides: 5, lidStyle: 'cap' }],
    ['polygon', { sides: 8, polyLid: false }],
    ['polygon', { sides: 3, snap: true, diameter: 120 }],
    ['jar', { grip: 'smooth', diameter: 50, height: 70 }],
    ['gridfinity', { gfLip: false, gfMagnets: true, gfX: 1, gfY: 1, gfZ: 3 }],
    ['gridfinity', { gfX: 3, gfY: 2, gfZ: 6, gfDividersY: 2 }],
  ];
  for (const [id, over] of cases) {
    it(`${id} ${JSON.stringify(over)}`, () => {
      const { parts } = buildType(id, over);
      const ids = Object.keys(parts);
      for (const k of ids) {
        expect(parts[k].status()).toBe('NoError');
        expect(parts[k].volume()).toBeGreaterThan(10);
      }
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) expect(overlap(parts[ids[i]], parts[ids[j]])).toBeLessThan(0.01);
      releaseAll();
    });
  }
});

describe('mechanisms', () => {
  it('hinged lid swings open without hitting the box', () => {
    const { R, parts } = buildType('hinged');
    const ay = R.axisY as number, az = R.Hb as number;
    for (const ang of [5, 15, 30, 60, 90, 120, 150, 175]) {
      const opened = parts.lid.translate([0, -ay, -az]).rotate([-ang, 0, 0]).translate([0, ay, az]);
      const v = overlap(opened, parts.base);
      expect(v, `collision at ${ang} deg: ${v.toFixed(3)}`).toBeLessThan(0.01);
    }
    releaseAll();
  });

  it('jar cap stays clear while unscrewing', () => {
    const { R, parts } = buildType('jar');
    const pitch = R.pitch as number;
    for (const turn of [0.1, 0.25, 0.5, 1, 1.5]) {
      const cap = parts.cap.rotate([0, 0, 360 * turn]).translate([0, 0, pitch * turn]); // right-hand: unscrew CCW
      const v = overlap(cap, parts.jar);
      expect(v, `collision at ${turn} turns: ${v.toFixed(3)}`).toBeLessThan(0.01);
    }
    // Screwing the wrong way (down) must collide, proving the threads engage.
    const wrong = parts.cap.rotate([0, 0, -90]); // turning clockwise without moving down
    expect(overlap(wrong, parts.jar)).toBeGreaterThan(1);
    releaseAll();
  });

  it('sliding lid slides out along -Y', () => {
    const { parts } = buildType('sliding');
    for (const dy of [2, 10, 30, 60]) expect(overlap(parts.lid.translate([0, -dy, 0]), parts.base)).toBeLessThan(0.01);
    expect(overlap(parts.lid.translate([0, 0, 1.5]), parts.base)).toBeGreaterThan(0.5); // dovetail holds it down
    releaseAll();
  });

  it('drawers slide out', () => {
    const { parts } = buildType('drawers');
    for (const dy of [5, 30, 70]) expect(overlap(parts.drawer2.translate([0, -dy, 0]), parts.sleeve)).toBeLessThan(0.01);
    releaseAll();
  });

  it('gridfinity bins stack', () => {
    const { R, parts } = buildType('gridfinity', { gfDividersX: 1, gfLabel: false });
    const upper = parts.bin.translate([0, 0, R.Hbody as number]);
    expect(overlap(upper, parts.bin)).toBeLessThan(0.05);
    // Dropped 0.5 mm lower it would collide: the lip actually locates the feet.
    expect(overlap(parts.bin.translate([0, 0, (R.Hbody as number) - 0.5]), parts.bin)).toBeGreaterThan(1);
    releaseAll();
  });
});

describe('kernel memory', () => {
  it('releases tracked objects', () => {
    buildType('lidded');
    releaseAll();
    const m = K().Manifold.cube([1, 1, 1]);
    expect(m.volume()).toBeCloseTo(1);
    releaseAll();
  });
});
