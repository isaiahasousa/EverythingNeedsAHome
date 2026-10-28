import type { Manifold } from 'manifold-3d';
import { IDENTITY, roundedRectPoints, rotX } from '../core/math';
import { box, cylY, profileXZ, profileYZ } from '../geometry/kernel';
import type { BoxParams, FaceDef, PartInfo, Resolved, Vec2 } from '../core/types';
import { clampRadius, F, fmt, planeFace, topNotchOutline, type BoxType } from './common';

/**
 * Largest front-edge radius that still leaves 0.8 mm of wall at the corners of the rectangular
 * compartments: the corner sits (r - t)·√2 from the arc centre, so r - (r - t)·√2 >= 0.8.
 */
const maxRadius = (t: number) => Math.max(0, (t * Math.SQRT2 - 0.8) / (Math.SQRT2 - 1));

function resolve(p: BoxParams): Resolved {
  const W = p.width, D = p.depth, H = p.height, t = p.wall;
  const n = Math.max(1, Math.round(p.drawerCount));
  const rWanted = clampRadius(p.radius, W, H);
  const r = Math.min(rWanted, maxRadius(t));
  const ch = (H - (n + 1) * t) / n; // compartment height
  const backT = p.closedBack ? t : 0;
  const c = p.drawerClearance;
  const dw = W - 2 * t - 2 * c;
  const dh = ch - c;
  const dd = D - backT - c;
  // Ledge tab, measured from the bottom of its drawer: a 45-degree underside so it prints upright.
  const tabTop = dh - 1.2;
  const tabBottom = Math.max(0.5, tabTop - Math.min(7, Math.max(3.5, dh * 0.22)) - 2);
  const tabOut = Math.max(1, Math.min(7, Math.max(3.5, dh * 0.22), tabTop - tabBottom - 0.5));
  const tabW = Math.min(32, dw * 0.4);
  const notchR = Math.min(12, dw * 0.2, dh * 0.45);
  const pullOut = p.drawerPull === 'tab' ? tabOut : 0;
  return {
    outer: [W, D + pullOut, H],
    inner: [dw - 2 * p.drawerWall, dd - 2 * p.drawerWall, dh - p.drawerFloor],
    W,
    D,
    H,
    r,
    rWanted,
    n,
    ch,
    dw,
    dh,
    dd,
    backT,
    tabTop,
    tabBottom,
    tabOut,
    tabW,
    notchR,
  };
}

/** Bottom Z of compartment k (0 = lowest). */
const compZ = (p: BoxParams, ch: number, k: number) => p.wall + k * (ch + p.wall);

export const drawers: BoxType = {
  id: 'drawers',
  name: 'Drawer cabinet',
  tagline: 'Sleeve with one or more sliding drawers.',
  dims: [
    { ...F.width, help: 'Cabinet width (X).' } as typeof F.width,
    { ...F.depth, help: 'Cabinet depth (Y), not counting the drawer pulls.' } as typeof F.depth,
    { ...F.height, help: 'Cabinet height (Z).' } as typeof F.height,
    { ...F.wall, label: 'Cabinet wall' } as typeof F.wall,
    { ...F.radius, help: 'Rounds the cabinet edges seen from the front. Thicker walls allow a larger radius.' } as typeof F.radius,
  ],
  usesDimsMode: false,
  groups: [
    {
      title: 'Drawers',
      params: [
        { kind: 'int', key: 'drawerCount', label: 'Drawers', min: 1, max: 8 },
        { kind: 'length', key: 'drawerWall', label: 'Drawer wall', min: 0.8, max: 5, step: 0.1 },
        { kind: 'length', key: 'drawerFloor', label: 'Drawer floor', min: 0.6, max: 5, step: 0.1 },
        {
          kind: 'select',
          key: 'drawerPull',
          label: 'Pull',
          options: [
            { value: 'tab', label: 'Ledge tab' },
            { value: 'notch', label: 'Finger notch' },
            { value: 'none', label: 'None' },
          ],
        },
        { kind: 'length', key: 'drawerClearance', label: 'Drawer clearance', min: 0.1, max: 1.5, step: 0.05, help: 'Gap around each drawer. 0.3-0.4 mm slides smoothly.' },
        { kind: 'toggle', key: 'closedBack', label: 'Closed back' },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, n = R.n as number, ch = R.ch as number, dw = R.dw as number, dh = R.dh as number;
    const t = p.wall;
    const faces: FaceDef[] = [
      planeFace('top', 'Cabinet top', 'sleeve', [0, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1], W - 2 * r, D, t),
      planeFace('left', 'Cabinet left', 'sleeve', [-W / 2, 0, H / 2], [0, -1, 0], [0, 0, 1], [-1, 0, 0], D, H - 2 * r, t),
      planeFace('right', 'Cabinet right', 'sleeve', [W / 2, 0, H / 2], [0, 1, 0], [0, 0, 1], [1, 0, 0], D, H - 2 * r, t),
    ];
    if (p.closedBack)
      faces.push(planeFace('back', 'Cabinet back', 'sleeve', [0, D / 2, H / 2], [-1, 0, 0], [0, 0, 1], [0, 1, 0], W - 2 * r, H - 2 * r, t, { onBed: true }));
    // Keep graphics off the pull: the tab stands out of the front and the notch is cut away.
    const outline =
      p.drawerPull === 'tab'
        ? topNotchOutline(dw, dh, { kind: 'rect', halfW: (R.tabW as number) / 2 + 0.5, depth: dh - (R.tabBottom as number) + 0.5 })
        : p.drawerPull === 'notch'
          ? topNotchOutline(dw, dh, { kind: 'arc', r: (R.notchR as number) + 0.3 })
          : undefined;
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i; // drawer 1 is the top one
      const z0 = compZ(p, ch, k);
      faces.push(planeFace(`drawer${i + 1}-front`, `Drawer ${i + 1} front`, `drawer${i + 1}`, [0, -D / 2, z0 + dh / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0], dw, dh, p.drawerWall, { outline }));
    }
    return faces;
  },
  parts(_p, R) {
    const n = R.n as number;
    const D = R.D as number;
    const parts: PartInfo[] = [
      { id: 'sleeve', name: 'Cabinet', print: rotX(-90), explode: [0, 0, 0], tip: 'Prints on its back with the openings facing up, so the shelves need no bridging.' },
    ];
    for (let i = 0; i < n; i++)
      parts.push({ id: `drawer${i + 1}`, name: `Drawer ${i + 1}`, print: IDENTITY, explode: [0, -(D * (0.7 - (0.45 * i) / Math.max(1, n - 1)) + 4), 0], tip: 'Print upright.' });
    return parts;
  },
  warnings(p, R) {
    const w = [];
    if ((R.ch as number) < 8) w.push({ level: 'error' as const, text: 'Drawers would be shorter than 8 mm. Use fewer drawers or a taller cabinet.' });
    if (p.drawerClearance < 0.2) w.push({ level: 'warn' as const, text: 'Less than 0.2 mm of clearance may make the drawers stick.' });
    if (p.wall < 1.2) w.push({ level: 'warn' as const, text: 'Cabinet walls under 1.2 mm are fragile.' });
    if (R.inner.some((v) => v <= 0)) w.push({ level: 'error' as const, text: 'The drawers have no room inside. Reduce wall thickness or enlarge the cabinet.' });
    if ((R.rWanted as number) > (R.r as number) + 0.01)
      w.push({ level: 'info' as const, text: `Corner radius limited to ${fmt(R.r as number)} mm so the corners keep at least 0.8 mm of wall around the drawers. Thicker walls allow more.` });
    return w;
  },
  build(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, n = R.n as number, ch = R.ch as number;
    const dw = R.dw as number, dh = R.dh as number, dd = R.dd as number;
    const t = p.wall;
    const outline: Vec2[] = roundedRectPoints(W, H, r, 8).map(([x, z]) => [x, z + H / 2]);
    let sleeve: Manifold = profileXZ(outline, -D / 2, D / 2);
    const backY = p.closedBack ? D / 2 - t : D / 2 + 1;
    for (let k = 0; k < n; k++) {
      const z0 = compZ(p, ch, k);
      sleeve = sleeve.subtract(box(-W / 2 + t, W / 2 - t, -D / 2 - 1, backY, z0, z0 + ch));
    }
    const out: Record<string, Manifold> = { sleeve };
    const wT = p.drawerWall;
    const tabW = R.tabW as number, tabOut = R.tabOut as number;
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i;
      const z0 = compZ(p, ch, k);
      const y0 = -D / 2, y1 = -D / 2 + dd;
      let d = box(-dw / 2, dw / 2, y0, y1, z0, z0 + dh).subtract(box(-dw / 2 + wT, dw / 2 - wT, y0 + wT, y1 - wT, z0 + p.drawerFloor, z0 + dh + 1));
      if (p.drawerPull === 'tab') {
        const zt = z0 + (R.tabTop as number);
        const zb = z0 + (R.tabBottom as number);
        // The underside rises at 45 degrees from the drawer front; the part inside the front just anchors it.
        const tab = profileYZ([[y0 + 0.8, zb], [y0, zb], [y0 - tabOut, zb + tabOut], [y0 - tabOut, zt], [y0 + 0.8, zt]], -tabW / 2, tabW / 2);
        d = d.add(tab);
      } else if (p.drawerPull === 'notch') {
        d = d.subtract(cylY(R.notchR as number, y0 - 1, y0 + wT + 1, 0, z0 + dh));
      }
      out[`drawer${i + 1}`] = d;
    }
    return out;
  },
};
