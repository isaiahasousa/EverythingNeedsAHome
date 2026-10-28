import { clipConvex, IDENTITY, rectPoints, roundedRectPoints, signedArea } from '../core/math';
import { box, loftRoundedRect, profileXZ, profileYZ, prism, rrect, unionAll } from '../geometry/kernel';
import type { BoxParams, Resolved } from '../core/types';
import { bottomFace, clampRadius, commonWarnings, F, fmt, notchOutline, planeFace, rectDims, wallFaces, type BoxType } from './common';

function resolve(p: BoxParams): Resolved {
  const lt = p.slideLid;
  const { W, D, H } = rectDims(p, p.floor + lt);
  const r = clampRadius(p.radius, W, D);
  const g = Math.max(0.2, Math.min(p.grooveDepth, p.wall - 0.4));
  // The thumb grip ridges sit in this strip from the front edge of the lid.
  const gripLen = Math.min(30, (W - 2 * p.wall - 2 * p.tolerance) * 0.5);
  return { outer: [W, D, H], inner: [W - 2 * p.wall, D - 2 * p.wall, H - p.floor - lt], r, W, D, H, lt, g, gripLen, gripDepth: 5 + 3 * 2.4 + 1.2 };
}

/**
 * The dovetail lid volume (or the slot it slides in) for clearance `c`: the intersection of a
 * trapezoid swept along Y (sides) and one swept along X (back edge). Wider at the bottom.
 */
function dovetail(W: number, D: number, H: number, t: number, lt: number, g: number, c: number, zTop: number, frontY: number) {
  const a = W / 2 - t;
  const hw = (z: number) => a + (g * (H - z)) / lt - c;
  const yb = (z: number) => D / 2 - t + (g * (H - z)) / lt - c;
  const z0 = H - lt;
  const sides = profileXZ([[-hw(z0), z0], [hw(z0), z0], [hw(zTop), zTop], [-hw(zTop), zTop]], frontY, D / 2 + 1);
  const back = profileYZ([[frontY, z0], [yb(z0), z0], [yb(zTop), zTop], [frontY, zTop]], -W / 2 - 1, W / 2 + 1);
  return sides.intersect(back);
}

/**
 * Keeps the slot (c = 0) or the lid (c = clearance) concentric with the rounded back corners, so the
 * slot never cuts through a corner. The front half is left alone: the lid has to pass the front wall.
 */
function cornerLimit(W: number, D: number, H: number, r: number, t: number, lt: number, g: number, c: number) {
  const e = 0.002; // a hair larger than the dovetail so their flat faces never coincide
  const loft = loftRoundedRect(W, D, r, [
    { inset: t - g + c - e, z: H - lt - 0.02 },
    { inset: t + c - e, z: H },
    { inset: t + c + g / lt - e, z: H + 1 },
  ]);
  return loft.add(box(-W, W, -D, 0, H - lt - 1, H + 2));
}

export const sliding: BoxType = {
  id: 'sliding',
  name: 'Sliding lid',
  tagline: 'Dovetail lid slides in from the front and sits flush.',
  dims: [F.width, F.depth, F.height, F.wall, F.floor, F.radius],
  usesDimsMode: true,
  groups: [
    {
      title: 'Lid',
      params: [
        { kind: 'length', key: 'slideLid', label: 'Lid thickness', min: 1, max: 8, step: 0.1 },
        { kind: 'length', key: 'grooveDepth', label: 'Groove depth', min: 0.3, max: 5, step: 0.1, help: 'How far the dovetail reaches into the walls. Keep at least 0.8 mm of wall behind it.' },
        F.tolerance,
        { kind: 'toggle', key: 'thumbGrip', label: 'Thumb grip', help: 'Shallow ridges near the front edge of the lid.' },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, lt = R.lt as number;
    const c = p.tolerance;
    const lidW = W - 2 * p.wall - 2 * c;
    const lidD = D - p.wall - c;
    const cy = -D / 2 + lidD / 2;
    // The lid's top is trimmed by the box's rounded outline and by the rounded slot at the back.
    const shift = (pts: [number, number][]) => pts.map(([x, y]) => [x, y - cy] as [number, number]);
    let lidOutline = clipConvex(rectPoints(lidW, lidD), shift(roundedRectPoints(W, D, r, 8)));
    const inset = p.wall + c;
    if (r > inset) lidOutline = clipConvex(lidOutline, shift(roundedRectPoints(W - 2 * inset, D - 2 * inset, r - inset, 8)));
    // Keep graphics off the thumb grip ridges near the front edge.
    if (p.thumbGrip) lidOutline = notchOutline(lidOutline, (R.gripLen as number) / 2 + 0.5, (R.gripDepth as number) + 0.5, 'bottom');
    // On a lid that is all grip there is no room left for graphics.
    const lidFaces = Math.abs(signedArea(lidOutline)) >= 20 ? [planeFace('lid-top', 'Lid top', 'lid', [0, cy, H], [1, 0, 0], [0, 1, 0], [0, 0, 1], lidW, lidD, lt, { outline: lidOutline })] : [];
    return [
      // The front wall stops under the lid; the others are thinned by the dovetail slot above H - lt.
      ...wallFaces('base', W, D, 0, H - lt, r, p.wall, '', '', ['front']),
      ...wallFaces('base', W, D, 0, H - lt - 0.3, r, p.wall, '', '', ['back', 'left', 'right']),
      ...lidFaces,
      bottomFace('base', W, D, r, p.floor),
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
        tip: gentle ? 'Print upright. The dovetail overhang is gentle enough to print without supports.' : 'Print upright, with supports for the dovetail groove (its overhang is steeper than 45°).',
      },
      { id: 'lid', name: 'Sliding lid', print: IDENTITY, explode: [0, -(D * 0.75 + 10), 4], tip: 'Print flat, top facing up.' },
    ];
  },
  warnings(p, R) {
    const w = commonWarnings(p, R);
    const g = R.g as number;
    // The lid's edge has to stay under the groove's overhang to be held in.
    const hold = g - p.tolerance;
    if ((R.W as number) - 2 * p.wall - 2 * p.tolerance < 4)
      w.push({ level: 'error', text: 'The box is too narrow for a sliding lid. Make it wider or the walls thinner.' });
    if (hold < 0.2)
      w.push({ level: 'error', text: `With ${fmt(p.tolerance)} mm of clearance in a ${fmt(g)} mm groove the lid would lift straight out. Use less clearance, or a deeper groove (thicker walls allow one).` });
    else if (hold < 0.4)
      w.push({ level: 'warn', text: `The lid only reaches ${fmt(hold)} mm under the groove and may pop out when the box is squeezed. Use less clearance or a deeper groove.` });
    if (p.grooveDepth > p.wall - 0.8)
      w.push({ level: 'warn', text: `Only ${fmt(p.wall - Math.min(p.grooveDepth, p.wall - 0.4))} mm of wall remains behind the groove. Use thicker walls or a shallower groove.` });
    if (p.slideLid < 1.6) w.push({ level: 'warn', text: 'A lid thinner than 1.6 mm may warp or snap.' });
    if (g > (R.lt as number) + 1e-9)
      w.push({ level: 'warn', text: `The groove is deeper than the lid is thick, so the dovetail overhang is steeper than 45° and needs supports. Use a lid at least ${fmt(g)} mm thick or a shallower groove.` });
    return w;
  },
  build(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, lt = R.lt as number, g = R.g as number;
    const t = p.wall;
    const outer = prism(rrect(W, D, r), 0, H);
    let base = outer.subtract(prism(rrect(W - 2 * t, D - 2 * t, Math.max(0, r - t)), p.floor, H + 1));
    base = base.subtract(dovetail(W, D, H, t, lt, g, 0, H + 1, -D / 2 - 1).intersect(cornerLimit(W, D, H, r, t, lt, g, 0)));
    let lid = dovetail(W, D, H, t, lt, g, p.tolerance, H, -D / 2)
      .intersect(outer)
      .intersect(cornerLimit(W, D, H, r, t, lt, g, p.tolerance));
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
