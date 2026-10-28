import type { CrossSection, Manifold } from 'manifold-3d';
import { IDENTITY, regularPolygon, rotX, roundedPolygonPoints } from '../core/math';
import { poly, prism } from '../geometry/kernel';
import type { BoxParams, FaceDef, LidStyle, PartInfo, Resolved, Vec2 } from '../core/types';
import { cavityRoom, commonWarnings, F, floorRoom, planeFace, topNotchOutline, type BoxType } from './common';
import { buildLidShell, lidGroup, lidLayout, lidWarnings, snapNotch, type SideAnchor } from './lidded';

function resolve(p: BoxParams): Resolved {
  const N = Math.max(3, Math.min(12, Math.round(p.sides)));
  const lt = p.polyLid ? Math.min(p.lidTop, p.lidHeight) : 0;
  const inner = p.dimsMode === 'inner';
  const flats = inner ? p.diameter + 2 * p.wall : p.diameter;
  // Inside sizes are usable space. An inset plug lid is narrower than the box all the way up (its lip
  // hangs inside the walls), so the full-width space ends where the lip starts.
  const plug = p.polyLid && p.lidStyle === 'plug';
  const H = inner ? p.height + p.floor + (plug ? p.lipHeight + Math.max(p.lidHeight, lt) : lt) : p.height;
  const Rc = flats / 2 / Math.cos(Math.PI / N);
  const L = p.polyLid ? lidLayout(p, H) : { style: 'plug' as LidStyle, lt: 0, Hl: 0, lipH: 0, Hb: H, neck: 0, skirt: p.wall };
  const rp = Math.max(0, Math.min(p.polyRound, flats / 4));
  const capGrow = p.polyLid && L.style === 'cap' ? 2 * (p.tolerance + p.wall) : 0;
  // The rounded outline is the polygon shrunk by rp and grown back with round corners.
  const pts = regularPolygon(N, Rc - rp / Math.cos(Math.PI / N));
  const spanX = Math.max(...pts.map(([x]) => x)) - Math.min(...pts.map(([x]) => x)) + 2 * rp;
  const spanY = Math.max(...pts.map(([, y]) => y)) - Math.min(...pts.map(([, y]) => y)) + 2 * rp;
  return {
    outer: [spanX + capGrow, spanY + capGrow, H],
    inner: [flats - 2 * p.wall, flats - 2 * p.wall, plug ? L.Hb - L.lipH - p.floor : H - p.floor - L.lt],
    N,
    flats,
    Rc,
    H,
    rp,
    minSpan: flats,
    clearH: H - p.floor - L.lt,
    ...L,
  };
}

function outlineFn(R: Resolved): (inset: number) => CrossSection {
  const N = R.N as number, Rc = R.Rc as number, rp = R.rp as number;
  const base = poly(regularPolygon(N, Rc));
  const rounded = rp > 0.05 ? base.offset(-rp, 'Miter', 10).offset(rp, 'Round') : base;
  return (i: number) => (Math.abs(i) < 1e-6 ? rounded : rounded.offset(-i, 'Round'));
}

function sideFrames(R: Resolved, apothem: number) {
  const N = R.N as number;
  return Array.from({ length: N }, (_, k) => {
    const th = -Math.PI / 2 + (k * 2 * Math.PI) / N;
    const n: [number, number, number] = [Math.cos(th), Math.sin(th), 0];
    const u: [number, number, number] = [-Math.sin(th), Math.cos(th), 0];
    return { k, n, u, o: [apothem * n[0], apothem * n[1]] as Vec2 };
  });
}

export const polygon: BoxType = {
  id: 'polygon',
  name: 'Polygon box',
  tagline: 'Hexagonal, octagonal or any 3-12 sided box, with an optional lid.',
  dims: [
    { kind: 'int', key: 'sides', label: 'Sides', min: 3, max: 12 },
    { kind: 'length', key: 'diameter', label: 'Across flats', min: 15, max: 400, help: 'Twice the distance from the centre to a flat side. With an odd number of sides a corner points backwards, so the box is deeper than this.' },
    F.height,
    F.wall,
    F.floor,
    { kind: 'length', key: 'polyRound', label: 'Corner rounding', min: 0, max: 20, step: 0.5 },
  ],
  usesDimsMode: true,
  groups: [
    { title: 'Lid', params: [{ kind: 'toggle', key: 'polyLid', label: 'Include a lid' }, ...(lidGroup.params as unknown as BoxType['groups'][number]['params'])] },
  ],
  resolve,
  faces(p, R) {
    const N = R.N as number, Rc = R.Rc as number, flats = R.flats as number, H = R.H as number, rp = R.rp as number;
    const apothem = flats / 2;
    const sideLen = 2 * Rc * Math.sin(Math.PI / N) - 2 * rp * Math.tan(Math.PI / N);
    const style = R.style as LidStyle;
    const lid = p.polyLid;
    const top = lid ? (style === 'cap' ? Math.max(1, H - (R.Hl as number) - 0.6) : (R.Hb as number)) : H;
    // Keep graphics off the snap grooves cut into the inside of the walls.
    const notch = lid ? snapNotch(p, R, sideLen) : null;
    const outline = notch ? topNotchOutline(sideLen, top, { kind: 'rect', ...notch }) : undefined;
    // Lithophanes may reach inward past the walls unless a plug lip comes down inside them.
    const innerRoom = lid && style === 'plug' ? 0 : cavityRoom(R);
    const faces: FaceDef[] = sideFrames(R, apothem).map(({ k, n, u, o }) =>
      planeFace(k === 0 ? 'front' : `side${k + 1}`, k === 0 ? 'Side 1 (front)' : `Side ${k + 1}`, 'base', [o[0], o[1], top / 2], u, [0, 0, 1], n, sideLen, top, p.wall, { outline, innerRoom }),
    );
    // The real rounded outline: graphics clipped to it never reach past a rounded corner.
    const outlinePts = roundedPolygonPoints(N, Rc, rp);
    if (lid) {
      const grow = style === 'cap' ? p.tolerance + p.wall : 0;
      const pts = roundedPolygonPoints(N, Rc, rp, grow);
      faces.push(planeFace('lid-top', 'Lid top', 'lid', [0, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2 * Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1])), R.lt as number, { onBed: true, outline: pts }));
    }
    const bottomPts: Vec2[] = outlinePts.map(([x, y]) => [x, -y] as Vec2).reverse();
    faces.push(planeFace('bottom', 'Bottom', 'base', [0, 0, 0], [1, 0, 0], [0, -1, 0], [0, 0, -1], R.outer[0], R.outer[1], p.floor, { onBed: true, outline: bottomPts, innerRoom: floorRoom(R) }));
    return faces;
  },
  parts(p, R) {
    const parts: PartInfo[] = [{ id: 'base', name: 'Box', print: IDENTITY, explode: [0, 0, 0], tip: 'Print upright. No supports needed.' }];
    if (p.polyLid) parts.push({ id: 'lid', name: 'Lid', print: rotX(180), explode: [0, 0, (R.Hl as number) + 14], tip: 'Prints upside down, top face on the bed.' });
    return parts;
  },
  warnings(p, R) {
    const w = commonWarnings(p, R);
    if (p.polyLid) w.push(...lidWarnings(p, R));
    return w;
  },
  build(p, R): Record<string, Manifold> {
    const outline = outlineFn(R);
    const H = R.H as number;
    if (!p.polyLid) {
      return { base: prism(outline(0), 0, H).subtract(prism(outline(p.wall), p.floor, H + 1)) };
    }
    const N = R.N as number, Rc = R.Rc as number, flats = R.flats as number, rp = R.rp as number;
    const sideLen = 2 * Rc * Math.sin(Math.PI / N) - 2 * rp * Math.tan(Math.PI / N);
    const sides: SideAnchor[] = sideFrames(R, flats / 2).map(({ n, o }) => ({ p: o, n: [n[0], n[1]], len: sideLen }));
    const { base, lid } = buildLidShell({
      outline,
      H,
      t: p.wall,
      f: p.floor,
      lt: R.lt as number,
      Hl: R.Hl as number,
      lipH: R.lipH as number,
      lipT: p.lipThickness,
      tol: p.tolerance,
      neck: R.neck as number,
      style: R.style as LidStyle,
      snap: p.snap,
      sides,
    });
    return { base, lid };
  },
};
