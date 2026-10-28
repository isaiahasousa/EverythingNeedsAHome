import type { Manifold } from 'manifold-3d';
import { clamp, IDENTITY, rotX } from '../core/math';
import { box, cylX, cylY, K, loftRoundedRect, prism, rrect, unionAll } from '../geometry/kernel';
import type { BoxParams, Resolved } from '../core/types';
import { bottomFace, cavityRoom, ceilTo, clampRadius, commonWarnings, EPS, F, floorRoom, fmt, planeFace, rectDims, topFace, topNotchOutline, wallFaces, withRoom, type BoxType } from './common';
import { lipTooThick } from './lidded';

/** Angle (degrees from horizontal) of the underside of a knuckle gusset whose strip runs `h` mm from the axis. */
function gussetAngle(rk: number, e: number, h: number) {
  const s = Math.min(3 * rk, h);
  return ((Math.atan2(s, e) - Math.asin(Math.min(1, rk / Math.hypot(s, e)))) * 180) / Math.PI;
}

const notchRadius = (W: number, Hb: number) => Math.min(10, W / 6, Hb * 0.6);

function resolve(p: BoxParams): Resolved {
  const lt = Math.min(p.lidTop, p.lidHeight);
  // Inside sizes are usable space. With the alignment lip the lid is narrower than the box all the way
  // up (the lip hangs inside the walls), so the full-width space ends where the lip starts.
  const { W, D, H } = rectDims(p, p.floor + (p.alignLip ? Math.min(p.lipHeight, 6) + Math.max(p.lidHeight, lt) : lt));
  const r = clampRadius(p.radius, W, D);
  const Hl = Math.max(p.lidHeight, lt);
  const Hb = H - Hl;
  const rk = Math.max(p.knuckleDiameter / 2, p.pinDiameter / 2 + 0.8);
  const gap = p.hingeGap;
  const e = rk + gap; // axis distance behind the back wall
  const n = Math.max(3, Math.round(p.knuckles) | 1);
  // The hinge never runs past the flat part of the back wall.
  const avail = Math.max(0, W - 2 * r);
  const span = Math.min(avail, Math.max(Math.min(avail, 6), (avail * clamp(p.hingeSpan, 20, 100)) / 100));
  const seg = (span - (n - 1) * gap) / n;
  const lipH = Math.max(0, Math.min(p.lipHeight, Hb - p.floor - 1, 6));
  const useLip = p.alignLip && lipH >= 1;
  // Shortest box part that still holds the floor and keeps the knuckles above the bed.
  const minHb = Math.max(p.floor + 2, rk + 0.5);
  return {
    outer: [W, D + e + rk, H],
    inner: [W - 2 * p.wall, D - 2 * p.wall, useLip ? Hb - lipH - p.floor : H - p.floor - lt],
    r,
    W,
    D,
    H,
    Hl,
    Hb,
    lt,
    rk,
    e,
    n,
    span,
    seg,
    lipH,
    useLip,
    minHb,
    clearH: H - p.floor - lt,
    lidWall: useLip ? p.wall + p.tolerance + p.lipThickness : p.wall,
    axisY: D / 2 + e,
  };
}

export const hinged: BoxType = {
  id: 'hinged',
  name: 'Hinged box',
  tagline: 'Lid on a pin hinge. Use a length of 1.75 mm filament as the pin.',
  dims: [F.width, F.depth, F.height, F.wall, F.floor, F.radius],
  usesDimsMode: true,
  groups: [
    {
      title: 'Lid',
      params: [
        { kind: 'length', key: 'lidHeight', label: 'Lid height', min: 2, max: 120, step: 0.5 },
        { kind: 'length', key: 'lidTop', label: 'Lid top thickness', min: 0.6, max: 10, step: 0.1 },
        { kind: 'toggle', key: 'alignLip', label: 'Alignment lip', help: 'A short lip under the lid keeps it centred when closed.' },
        { kind: 'length', key: 'lipHeight', label: 'Lip depth', min: 1, max: 6, step: 0.5 },
        { kind: 'length', key: 'lipThickness', label: 'Lip thickness', min: 0.8, max: 4, step: 0.1 },
        F.tolerance,
        { kind: 'toggle', key: 'frontNotch', label: 'Finger notch', help: 'A scoop in the front wall to lift the lid.' },
      ],
    },
    {
      title: 'Hinge',
      params: [
        { kind: 'int', key: 'knuckles', label: 'Knuckles', min: 3, max: 15, help: 'Odd numbers keep the outer knuckles on the box.' },
        { kind: 'length', key: 'knuckleDiameter', label: 'Knuckle diameter', min: 4, max: 20, step: 0.5 },
        { kind: 'length', key: 'pinDiameter', label: 'Pin hole', min: 1, max: 8, step: 0.05, help: '2.0 mm takes 1.75 mm filament as a pin.' },
        { kind: 'length', key: 'hingeGap', label: 'Hinge clearance', min: 0.2, max: 1.2, step: 0.05 },
        { kind: 'number', key: 'hingeSpan', label: 'Hinge length', min: 20, max: 100, step: 5, unit: '%' },
        { kind: 'toggle', key: 'printedPin', label: 'Print a pin', help: 'Adds a flat-bottomed pin part instead of using filament.' },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, Hb = R.Hb as number, Hl = R.Hl as number, lt = R.lt as number, rk = R.rk as number;
    // Lithophanes may reach inward past the box walls, but not up where the alignment lip comes down
    // inside them; under the lid top there is the lid's own cavity.
    const open = cavityRoom(R);
    const roomTop = R.useLip ? Hb / 2 - (R.lipH as number) - 0.3 : undefined;
    const front = planeFace('front', 'Front', 'base', [0, -D / 2, Hb / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0], W - 2 * r, Hb, p.wall, {
      outline: p.frontNotch ? topNotchOutline(W - 2 * r, Hb, { kind: 'arc', r: notchRadius(W, Hb) }) : undefined,
      innerRoom: open,
      roomTop,
    });
    const faces = [
      front,
      ...wallFaces('base', W, D, 0, Hb, r, p.wall, '', '', ['left', 'right']).map((f) => ({ ...f, innerRoom: open, roomTop })),
      { ...topFace('lid-top', 'Lid top', 'lid', W, D, r, H, lt, true), innerRoom: Math.max(0, Hl - lt - 0.5) },
    ];
    // The back face always ends below the knuckles, so well below the lip.
    const backTop = Hb - 3 * rk - 1;
    if (backTop >= 6) faces.push(...withRoom(wallFaces('base', W, D, 0, backTop, r, p.wall, '', '', ['back']), open));
    if (Hl - lt >= 5) faces.push(...withRoom(wallFaces('lid', W, D, Hb, H, r, R.lidWall as number, 'lid-', 'Lid', ['front', 'left', 'right']), open));
    faces.push({ ...bottomFace('base', W, D, r, p.floor), innerRoom: floorRoom(R) });
    return faces;
  },
  parts(p, R) {
    const axisY = R.axisY as number, Hb = R.Hb as number, Hl = R.Hl as number;
    const parts = [
      { id: 'base', name: 'Box', print: IDENTITY, explode: [0, 0, 0] as [number, number, number], tip: 'Print upright. The knuckle gussets are self-supporting.' },
      {
        id: 'lid',
        name: 'Lid',
        print: rotX(180),
        explode: [0, 0, 0] as [number, number, number],
        open: { axis: [1, 0, 0] as [number, number, number], angle: -105, pivot: [0, axisY, Hb] as [number, number, number] },
        tip: 'Prints upside down, top face on the bed.',
      },
    ];
    if (p.printedPin) parts.push({ id: 'pin', name: 'Hinge pin', print: IDENTITY, explode: [(R.span as number) * 0.7 + 10, 0, 0], tip: 'Prints lying on its flat side.' });
    void Hl;
    return parts;
  },
  warnings(p, R) {
    const w = commonWarnings(p, R);
    const Hl = R.Hl as number, rk = R.rk as number, Hb = R.Hb as number, e = R.e as number;
    const minHb = R.minHb as number;
    if (Hb < minHb - EPS) {
      // The height that gives the box part `minHb`, in the units the height field uses (inside sizing
      // adds the floor and the lid, or with the alignment lip the lip and the whole lid; see resolve).
      const lip = p.alignLip ? Math.min(p.lipHeight, 6) : 0;
      const need = p.dimsMode === 'inner' ? (p.alignLip ? minHb - p.floor - lip : minHb + Hl - p.floor - (R.lt as number)) : Hl + minHb;
      w.push({ level: 'error', text: `The box is too short for a ${fmt(Hl)} mm lid and ${fmt(2 * rk)} mm knuckles. Set the height to at least ${fmt(Math.max(6, ceilTo(need, 0.5)))} mm, or lower the lid.` });
    }
    if (Hl < rk - EPS) w.push({ level: 'error', text: `The lid must be at least ${fmt(ceilTo(rk, 0.1))} mm tall to hold the hinge knuckles.` });
    if (R.useLip && Math.min(R.W as number, R.D as number) - 2 * (p.wall + p.tolerance + p.lipThickness) < 2 - EPS)
      w.push({ level: 'error', text: lipTooThick(Math.min(R.W as number, R.D as number), p, 'turn the alignment lip off') });
    if ((R.span as number) < 6) w.push({ level: 'error', text: 'The box is too narrow for a hinge. Make it wider or reduce the corner radius.' });
    else if ((R.seg as number) < 2) w.push({ level: 'error', text: `The hinge is too short for ${R.n} knuckles. Use fewer knuckles or a longer hinge.` });
    if (Hb >= minHb && gussetAngle(rk, e, Hb) < 40) w.push({ level: 'warn', text: 'The knuckles on the box will need supports at this height. Make the box taller or the knuckles smaller.' });
    if (Hl >= rk && gussetAngle(rk, e, Hl) < 40) w.push({ level: 'warn', text: 'The knuckles on the lid will need supports. Use a taller lid or smaller knuckles.' });
    if (rk - p.pinDiameter / 2 < 1) w.push({ level: 'warn', text: 'Knuckle walls around the pin are thinner than 1 mm.' });
    if (Math.round(p.knuckles) % 2 === 0) w.push({ level: 'info', text: 'Knuckle count rounded up to an odd number.' });
    return w;
  },
  build(p, R) {
    const { Manifold } = K();
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number, Hb = R.Hb as number, lt = R.lt as number;
    const rk = R.rk as number, e = R.e as number, n = R.n as number, span = R.span as number;
    const t = p.wall, tol = p.tolerance, gap = p.hingeGap;
    const ay = D / 2 + e, az = Hb;
    const outline = (i: number) => rrect(W - 2 * i, D - 2 * i, Math.max(0, r - i));

    let base = prism(outline(0), 0, Hb).subtract(prism(outline(t), p.floor, Hb + 1));
    const lipT = p.lipThickness;
    const lipH = R.lipH as number;
    const useLip = R.useLip as boolean;
    let lid = prism(outline(0), Hb, H);
    if (H - lt > Hb + 0.01) lid = lid.subtract(prism(outline(useLip ? t + tol + lipT : t), Hb - 1, H - lt));
    if (useLip) {
      // The lip's lower edge swings forward on an arc as the lid opens; taper it to clear the front wall.
      const taper = (lipH * lipH) / (2 * (D - t)) + 0.15;
      const ring = loftRoundedRect(W, D, r, [
        { inset: t + tol + taper, z: Hb - lipH },
        { inset: t + tol, z: Hb + 0.02 },
      ]).subtract(prism(outline(t + tol + lipT), Hb - lipH - 1, Hb + 1));
      lid = unionAll([lid, ring]);
    }
    if (p.frontNotch) base = base.subtract(cylY(notchRadius(W, Hb), -D / 2 - 1, -D / 2 + t + 1, 0, Hb));

    // Knuckles: alternate box / lid along X, each a hull of the barrel and a strip on its wall.
    const seg = (span - (n - 1) * gap) / n;
    const cz = 0.2;
    const baseK: Manifold[] = [];
    const lidK: Manifold[] = [];
    for (let i = 0; i < n; i++) {
      const x0 = -span / 2 + i * (seg + gap);
      const x1 = x0 + seg;
      const barrel = cylX(rk, x0, x1, ay, az);
      if (i % 2 === 0) {
        const strip = box(x0, x1, D / 2 - 0.6, D / 2, Math.max(0, Hb - 3 * rk), Hb - cz);
        const k = Manifold.hull([barrel, strip]).subtract(box(x0 - 1, x1 + 1, D / 2 - 2, D / 2 + gap, Hb - cz, Hb + 20));
        baseK.push(k);
      } else {
        const strip = box(x0, x1, D / 2 - 0.6, D / 2, Hb + cz, Math.min(H, Hb + 3 * rk));
        const k = Manifold.hull([barrel, strip]).subtract(box(x0 - 1, x1 + 1, D / 2 - 2, D / 2 + gap, Hb - 20, Hb + cz));
        lidK.push(k);
      }
    }
    const pinHole = cylX(p.pinDiameter / 2, -span / 2 - 1, span / 2 + 1, ay, az);
    base = unionAll([base, ...baseK]).subtract(pinHole);
    lid = unionAll([lid, ...lidK]).subtract(pinHole);
    const out: Record<string, Manifold> = { base, lid };
    if (p.printedPin) {
      const pr = p.pinDiameter / 2 - 0.12;
      out.pin = cylX(pr, -span / 2, span / 2, ay, az).intersect(box(-span, span, ay - pr - 1, ay + pr + 1, az - pr * 0.7, az + pr + 1));
    }
    return out;
  },
};
