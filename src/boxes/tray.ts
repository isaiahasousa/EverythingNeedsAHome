import { IDENTITY } from '../core/math';
import { box, prism, rrect, unionAll } from '../geometry/kernel';
import type { BoxParams, Resolved } from '../core/types';
import { bottomFace, cavityRoom, clampRadius, commonWarnings, F, floorRoom, rectDims, wallFaces, withRoom, type BoxType } from './common';

function resolve(p: BoxParams): Resolved {
  const { W, D, H } = rectDims(p, p.floor);
  const r = clampRadius(p.radius, W, D);
  return { outer: [W, D, H], inner: [W - 2 * p.wall, D - 2 * p.wall, H - p.floor], r };
}

/** Centres of the dividers splitting `inner` into `n` equal compartments. */
export function dividerCentres(inner: number, n: number, t: number): number[] {
  const out: number[] = [];
  if (n < 2) return out;
  const cell = (inner - (n - 1) * t) / n;
  for (let i = 1; i < n; i++) out.push(-inner / 2 + i * cell + (i - 0.5) * t);
  return out;
}

export const tray: BoxType = {
  id: 'tray',
  name: 'Open tray',
  tagline: 'Open-top box with optional compartment grid.',
  dims: [F.width, F.depth, { ...F.height, help: 'Total height (Z).' } as typeof F.height, F.wall, F.floor, F.radius],
  usesDimsMode: true,
  groups: [
    {
      title: 'Compartments',
      params: [
        { kind: 'int', key: 'dividersX', label: 'Columns', min: 1, max: 12, help: 'Compartments left to right.' },
        { kind: 'int', key: 'dividersY', label: 'Rows', min: 1, max: 12, help: 'Compartments front to back.' },
        { kind: 'length', key: 'dividerThickness', label: 'Divider thickness', min: 0.8, max: 6, step: 0.1 },
        { kind: 'number', key: 'dividerHeight', label: 'Divider height', min: 20, max: 100, step: 5, unit: '%' },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const [W, D, H] = R.outer;
    const r = R.r as number;
    // An open tray has nothing behind its walls or above its floor: lithophanes may reach inward.
    return [...withRoom(wallFaces('base', W, D, 0, H, r, p.wall), cavityRoom(R)), { ...bottomFace('base', W, D, r, p.floor), innerRoom: floorRoom(R, p.floor) }];
  },
  parts() {
    return [{ id: 'base', name: 'Tray', print: IDENTITY, explode: [0, 0, 0], tip: 'Print upright. No supports needed.' }];
  },
  warnings(p, R) {
    const w = commonWarnings(p, R);
    const cols = Math.round(p.dividersX), rows = Math.round(p.dividersY);
    const [iw, id] = R.inner;
    if (cols > 1 && (iw - (cols - 1) * p.dividerThickness) / cols < 5) w.push({ level: 'warn', text: 'Columns are narrower than 5 mm.' });
    if (rows > 1 && (id - (rows - 1) * p.dividerThickness) / rows < 5) w.push({ level: 'warn', text: 'Rows are shallower than 5 mm.' });
    return w;
  },
  build(p, R) {
    const [W, D, H] = R.outer;
    const r = R.r as number;
    const t = p.wall;
    const outer = prism(rrect(W, D, r), 0, H);
    const cavity = prism(rrect(W - 2 * t, D - 2 * t, Math.max(0, r - t)), p.floor, H + 1);
    let body = outer.subtract(cavity);
    const iw = W - 2 * t, id = D - 2 * t;
    const dh = p.floor + (H - p.floor) * Math.min(1, Math.max(0.05, p.dividerHeight / 100));
    const dt = p.dividerThickness;
    const slabs = [
      ...dividerCentres(iw, Math.round(p.dividersX), dt).map((x) => box(x - dt / 2, x + dt / 2, -id / 2 - t / 2, id / 2 + t / 2, p.floor - 0.01, dh)),
      ...dividerCentres(id, Math.round(p.dividersY), dt).map((y) => box(-iw / 2 - t / 2, iw / 2 + t / 2, y - dt / 2, y + dt / 2, p.floor - 0.01, dh)),
    ];
    // Dividers reach halfway into the walls; clip them there so none pokes out of a rounded corner.
    if (slabs.length) body = unionAll([body, unionAll(slabs).intersect(prism(rrect(W - t, D - t, Math.max(0, r - t / 2)), p.floor - 0.02, dh + 0.01))]);
    return { base: body };
  },
};
