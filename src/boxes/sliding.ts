import { clipConvex, IDENTITY, rectPoints, roundedRectPoints, signedArea } from '../core/math';
import type { BoxParams, Resolved, Vec3 } from '../core/types';
import { box, K, profileXZ, profileYZ, prism, rrect, unionAll } from '../geometry/kernel';
import { bottomFace, cavityRoom, ceilTo, clampRadius, commonWarnings, EPS, F, floorRoom, fmt, notchOutline, planeFace, wallFaces, withRoom, type BoxType } from './common';

/**
 * The lid's edges sit `se` in from the outside (never less than the wall), held by a solid rim. Under the
 * rim the walls lean in at 45 degrees from `zc`, so it prints without supports. In inner sizing, width and
 * depth are the opening the lid covers, and height is the clear space under the lid.
 */
function resolve(p: BoxParams): Resolved {
  const lt = p.slideLid;
  const t = p.wall;
  const se = Math.max(p.lidInset, t);
  const inner = p.dimsMode === 'inner';
  const W = inner ? p.width + 2 * se : p.width;
  const D = inner ? p.depth + se + t : p.depth;
  const H = inner ? p.height + p.floor + lt : p.height;
  const r = clampRadius(p.radius, W, D);
  const g = Math.max(0.2, Math.min(p.grooveDepth, se - 0.4));
  const zc = Math.max(p.floor, H - lt - (se - t));
  // The thumb grip ridges sit in this strip from the front edge of the lid.
  const gripLen = Math.min(30, (W - 2 * se - 2 * p.tolerance) * 0.5);
  return { outer: [W, D, H], inner: [W - 2 * se, D - se - t, H - lt - p.floor], r, W, D, H, lt, g, se, zc, gripLen, gripDepth: 5 + 3 * 2.4 + 1.2 };
}

/**
 * The dovetail lid volume (or the slot it slides in) for clearance `c`, with square corners: the
 * intersection of a trapezoid swept along Y (sides) and one swept along X (back edge). Wider at the bottom.
 */
function dovetail(W: number, D: number, H: number, inset: number, lt: number, g: number, c: number, zTop: number, frontY: number) {
  const a = W / 2 - inset;
  const hw = (z: number) => a + (g * (H - z)) / lt - c;
  const yb = (z: number) => D / 2 - inset + (g * (H - z)) / lt - c;
  const z0 = H - lt;
  const sides = profileXZ([[-hw(z0), z0], [hw(z0), z0], [hw(zTop), zTop], [-hw(zTop), zTop]], frontY, D / 2 + 1);
  const back = profileYZ([[frontY, z0], [yb(z0), z0], [yb(zTop), zTop], [frontY, zTop]], -W / 2 - 1, W / 2 + 1);
  return sides.intersect(back);
}

/** Material left between a rounded outside corner (radius `r`) and a square corner `a` in from both sides. */
const cornerMaterial = (r: number, a: number) => (a >= r ? a : r - Math.SQRT2 * (r - a));

export const sliding: BoxType = {
  id: 'sliding',
  name: 'Sliding lid',
  tagline: 'Dovetail lid slides in from the front and sits flush, framed by a solid rim.',
  dims: [F.width, F.depth, F.height, F.wall, F.floor, F.radius],
  usesDimsMode: true,
  groups: [
    {
      title: 'Lid',
      params: [
        { kind: 'length', key: 'slideLid', label: 'Lid thickness', min: 1, max: 8, step: 0.1 },
        { kind: 'length', key: 'lidInset', label: 'Lid inset', min: 4, max: 30, step: 0.5, help: "How far the lid's edges sit in from the outside of the box. At least 4 mm, so a solid rim surrounds the lid's square corners." },
        { kind: 'length', key: 'grooveDepth', label: 'Groove depth', min: 0.3, max: 5, step: 0.1, help: 'How far the dovetail reaches into the rim.' },
        F.tolerance,
        { kind: 'toggle', key: 'thumbGrip', label: 'Thumb grip', help: 'Shallow ridges near the front edge of the lid.' },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, lt = R.lt as number, se = R.se as number, zc = R.zc as number;
    const c = p.tolerance;
    const lidW = W - 2 * se - 2 * c;
    const lidD = D - se - c;
    const cy = -D / 2 + lidD / 2;
    // The lid's front corners are trimmed by the box's rounded outline when the corners are very round.
    const shift = (pts: [number, number][]) => pts.map(([x, y]) => [x, y - cy] as [number, number]);
    let lidOutline = clipConvex(rectPoints(lidW, lidD), shift(roundedRectPoints(W, D, r, 8)));
    // Keep graphics off the thumb grip ridges near the front edge.
    if (p.thumbGrip) lidOutline = notchOutline(lidOutline, (R.gripLen as number) / 2 + 0.5, (R.gripDepth as number) + 0.5, 'bottom');
    // On a lid that is all grip there is no room left for graphics.
    const lidFaces = Math.abs(signedArea(lidOutline)) >= 20 ? [planeFace('lid-top', 'Lid top', 'lid', [0, cy, H], [1, 0, 0], [0, 1, 0], [0, 0, 1], lidW, lidD, lt, { outline: lidOutline })] : [];
    // The other walls are only `wall` thick below the rim, where they start to lean in under it.
    const sideTop = (se > p.wall + EPS ? zc : H - lt) - 0.3;
    return [
      // The front wall stops under the lid; the lid rides in the rim, so the cavity behind the walls is free
      // for lithophanes.
      ...withRoom(wallFaces('base', W, D, 0, H - lt, r, p.wall, '', '', ['front']), cavityRoom(R)),
      ...withRoom(wallFaces('base', W, D, 0, sideTop, r, p.wall, '', '', ['back', 'left', 'right']), cavityRoom(R)),
      ...lidFaces,
      { ...bottomFace('base', W, D, r, p.floor), innerRoom: floorRoom(R, p.floor, zc) },
    ];
  },
  parts(_p, R) {
    const D = R.D as number;
    const gentle = (R.g as number) <= (R.lt as number) + 1e-9;
    return [
      {
        id: 'base',
        name: 'Box',
        print: IDENTITY,
        explode: [0, 0, 0],
        tip: gentle ? 'Print upright. The dovetail and the rim are gentle enough to print without supports.' : 'Print upright, with supports for the dovetail groove (its overhang is steeper than 45°).',
      },
      { id: 'lid', name: 'Sliding lid', print: IDENTITY, explode: [0, -(D * 0.75 + 10), 4], tip: 'Print flat, top facing up.' },
    ];
  },
  warnings(p, R) {
    const w = commonWarnings(p, R);
    const g = R.g as number, se = R.se as number, lt = R.lt as number, r = R.r as number;
    // The lid's edge has to stay under the groove's overhang to be held in.
    const hold = g - p.tolerance;
    if ((R.W as number) - 2 * se - 2 * p.tolerance < 4)
      w.push({ level: 'error', text: `The box is too narrow for a lid set ${fmt(se)} mm in from the sides. Make it at least ${fmt(ceilTo(2 * se + 2 * p.tolerance + 4, 0.5))} mm wide or use a smaller lid inset.` });
    if (hold < 0.2)
      w.push({ level: 'error', text: `With ${fmt(p.tolerance)} mm of tolerance in a ${fmt(g)} mm groove the lid would lift straight out. Use less tolerance, or a deeper groove.` });
    else if (hold < 0.4)
      w.push({ level: 'warn', text: `The lid only reaches ${fmt(hold)} mm under the groove and may pop out when the box is squeezed. Use less tolerance or a deeper groove.` });
    if (p.grooveDepth > se - 0.8)
      w.push({ level: 'warn', text: `Only ${fmt(se - g)} mm of rim remains outside the groove. Use a larger lid inset or a shallower groove.` });
    // The slot's square corners must stay inside the box's rounded outside corners.
    const a = se - g;
    const left = cornerMaterial(r, a);
    if (left < 0.8 - EPS) {
      const maxR = Math.floor(((Math.SQRT2 * a - 0.8) / (Math.SQRT2 - 1)) * 2 + EPS) / 2;
      const minInset = ceilTo(g + r - (r - 0.8) / Math.SQRT2, 0.5);
      w.push({
        level: 'error',
        text: `The rounded box corners leave only ${fmt(Math.max(0, left))} mm around the lid's square corners. Use a corner radius of at most ${fmt(Math.max(0, maxR))} mm, or a lid inset of at least ${fmt(minInset)} mm.`,
      });
    }
    if (p.slideLid < 1.6) w.push({ level: 'warn', text: 'A lid thinner than 1.6 mm may warp or snap.' });
    if (g > lt + 1e-9)
      w.push({ level: 'warn', text: `The groove is deeper than the lid is thick, so the dovetail overhang is steeper than 45° and needs supports. Use a lid at least ${fmt(g)} mm thick or a shallower groove.` });
    if ((R.H as number) - lt - (se - p.wall) < p.floor - EPS)
      w.push({
        level: 'warn',
        text: `The box is too short for a ${fmt(se)} mm rim: under it the walls lean in more steeply than 45° and need supports. Make the box at least ${fmt(ceilTo(p.floor + lt + se - p.wall, 0.5))} mm tall or use a smaller lid inset.`,
      });
    return w;
  },
  build(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, lt = R.lt as number, g = R.g as number, se = R.se as number, zc = R.zc as number;
    const t = p.wall;
    const outer = prism(rrect(W, D, r), 0, H);
    // The cavity: straight walls up to `zc`, then leaning in at 45 degrees to the opening under the lid
    // (one convex hull, so there is no ledge where they meet). The front wall stays straight: the lid
    // slides in over it.
    let cavity = prism(rrect(W - 2 * t, D - 2 * t, Math.max(0, r - t)), p.floor, H - lt + 0.01);
    const rise = se - t;
    if (rise > EPS) {
      const rho = Math.max(0, r - t);
      const top = H - lt + 0.01;
      // The walls `d` further in at the sides and back. Their corners shrink with them until they are
      // square, so the corners lean no more than the walls do.
      const level = (d: number) => {
        const z = zc + ((top - zc) * d) / rise;
        return roundedRectPoints(W - 2 * t - 2 * d, D - 2 * t - d, Math.max(0, rho - d), 8).map(([x, y]) => [x, y - d / 2, z] as Vec3);
      };
      const walls = level(0).map(([x, y]) => [x, y, p.floor] as Vec3);
      cavity = K().Manifold.hull([...walls, ...level(0), ...level(Math.min(rho, rise)), ...level(rise)]);
    }
    let base = outer.subtract(cavity);
    base = base.subtract(dovetail(W, D, H, se, lt, g, 0, H + 1, -D / 2 - 1));
    let lid = dovetail(W, D, H, se, lt, g, p.tolerance, H, -D / 2).intersect(outer);
    if (p.thumbGrip) {
      const len = R.gripLen as number;
      const ridges = [0, 1, 2, 3].map((i) => {
        const y = -D / 2 + 5 + i * 2.4;
        return box(-len / 2, len / 2, y, y + 1.2, H - 0.6, H + 1);
      });
      lid = lid.subtract(unionAll(ridges));
    }
    return { base, lid };
  },
};
