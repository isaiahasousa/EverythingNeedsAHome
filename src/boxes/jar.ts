import { circlePoints, IDENTITY, rotX } from '../core/math';
import { circle, coneZ, cylZ, helicalRidge, K, prism, unionAll } from '../geometry/kernel';
import type { BoxParams, FaceDef, Resolved } from '../core/types';
import { F, fmt, planeFace, type BoxType } from './common';

/**
 * Thread layout shared by the neck and the cap. With 45-degree flanks the neck ridge and the cap
 * ridge are the same trapezoid; the cap's sits half a pitch away and `clearance` further out.
 */
export function threadLayout(pitch: number, depth: number) {
  const flank = depth; // 45 degrees
  const flat = Math.max(0.2, (pitch - 2 * flank) / 2);
  return { flank, crest: flat, root: flat, base: flat + 2 * flank, tip: flat };
}

/** Deepest thread that keeps a 0.2 mm flat at crest and root, so both flanks get the full clearance. */
export const maxThreadDepth = (pitch: number) => Math.max(0.3, Math.min(pitch * 0.4, (pitch - 0.4) / 2));

/** How far knurl notches reach into the cap wall: never closer than 0.8 mm to the inside. */
export const knurlDepth = (wall: number) => Math.min(0.6, wall - 0.8);

function resolve(p: BoxParams): Resolved {
  const t = p.wall;
  const inner = p.dimsMode === 'inner';
  const pitch = Math.max(1, p.threadPitch);
  const td = Math.min(Math.max(0.3, p.threadDepth), maxThreadDepth(pitch));
  const tn = Math.max(1.2, t);
  // Sized from the inside, the diameter is the opening: what fits through the neck.
  const Dm = inner ? p.diameter + 2 * (t + p.threadClearance + td + tn) : p.diameter;
  const R = Dm / 2;
  // The cap ridge sits half a pitch below the neck ridge, and both taper in and out over a quarter
  // turn, so the thread must be long enough for the ridges to overlap by a full turn at full depth.
  const minL = 1.1 + threadLayout(pitch, td).base + 2 * pitch;
  const L = Math.max(minL, p.threadLength);
  const c = p.threadClearance;
  const capTop = p.lidTop;
  const rc = R - t; // cap inner wall radius (thread root of the cap)
  const rMajor = rc - c; // neck crest
  const rn = rMajor - td; // neck root
  const rBore = rn - tn;
  const Hcap = L + 0.6 + capTop;
  // Inside height runs from the floor to the underside of the cap.
  const H = inner ? p.height + p.floor + capTop : p.height;
  const Hb = H - Hcap;
  // The inner shoulder narrows the body to the neck bore at 45 degrees below the cap.
  const shoulderBottom = Hb - 1.2 - Math.max(0, R - t - rBore);
  return { outer: [Dm, Dm, H], inner: [2 * rBore, 2 * rBore, H - p.floor - capTop], R, pitch, td, L, minL, c, capTop, rc, rn, tn, rBore, Hcap, Hb, H, shoulderBottom };
}

export const jar: BoxType = {
  id: 'jar',
  name: 'Screw-top jar',
  tagline: 'Round container with a threaded cap.',
  dims: [
    { kind: 'length', key: 'diameter', label: 'Diameter', min: 20, max: 300, help: 'Outside diameter. When sizing by the inside, the width of the opening, which is what fits in.' },
    { ...F.height, help: 'Total height with the cap on.' } as typeof F.height,
    F.wall,
    F.floor,
  ],
  usesDimsMode: true,
  groups: [
    {
      title: 'Thread',
      params: [
        { kind: 'length', key: 'threadPitch', label: 'Pitch', min: 1.5, max: 8, step: 0.25, help: 'Height of one turn. 3 mm is forgiving on most printers.' },
        { kind: 'length', key: 'threadDepth', label: 'Thread depth', min: 0.4, max: 3, step: 0.1 },
        { kind: 'length', key: 'threadLength', label: 'Thread length', min: 3, max: 40, step: 0.5 },
        { kind: 'length', key: 'threadClearance', label: 'Thread clearance', min: 0.1, max: 1.2, step: 0.05, help: 'Radial gap between the threads. 0.3-0.5 mm.' },
      ],
    },
    {
      title: 'Cap',
      params: [
        { kind: 'length', key: 'lidTop', label: 'Cap top thickness', min: 0.8, max: 8, step: 0.1 },
        {
          kind: 'select',
          key: 'grip',
          label: 'Grip',
          options: [
            { value: 'knurl', label: 'Knurled' },
            { value: 'smooth', label: 'Smooth' },
          ],
        },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const Rr = R.R as number, H = R.H as number, Hcap = R.Hcap as number, Hb = R.Hb as number;
    // The body wall is `wall` thick only below the inner shoulder that narrows it to the neck.
    const bodyTop = Math.max(1.2, (R.shoulderBottom as number) - 0.3);
    const faces: FaceDef[] = [
      {
        id: 'front',
        label: 'Body (wraps around)',
        partId: 'jar',
        kind: 'cylinder',
        origin: [0, 0, (0.4 + bodyTop) / 2],
        u: [1, 0, 0],
        v: [0, 0, 1],
        n: [0, -1, 0],
        radius: Rr,
        angle0: -Math.PI / 2,
        width: Math.PI * 2 * Rr * 0.98,
        height: bodyTop - 0.4,
        outline: [],
        thickness: p.wall,
      },
      planeFace('lid-top', 'Cap top', 'cap', [0, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2 * Rr, 2 * Rr, p.lidTop, {
        onBed: true,
        outline: circlePoints(Rr - (p.grip === 'knurl' ? 1.6 : 0.8), 96),
      }),
      planeFace('bottom', 'Bottom', 'jar', [0, 0, 0], [1, 0, 0], [0, -1, 0], [0, 0, -1], 2 * Rr, 2 * Rr, p.floor, {
        onBed: true,
        outline: circlePoints(Rr - 0.6, 96),
      }),
    ];
    const body = faces[0];
    body.outline = [[-body.width / 2, -body.height / 2], [body.width / 2, -body.height / 2], [body.width / 2, body.height / 2], [-body.width / 2, body.height / 2]];
    if (p.grip === 'smooth' && Hcap - p.lidTop >= 6) {
      faces.push({
        ...body,
        id: 'cap-side',
        label: 'Cap side (wraps around)',
        partId: 'cap',
        // The thread and the cap top are behind this wall: engrave it, never cut through it.
        solid: true,
        origin: [0, 0, Hb + Hcap / 2],
        height: Hcap - 1,
        outline: [[-body.width / 2, -(Hcap - 1) / 2], [body.width / 2, -(Hcap - 1) / 2], [body.width / 2, (Hcap - 1) / 2], [-body.width / 2, (Hcap - 1) / 2]],
      });
    }
    return faces;
  },
  parts(_p, R) {
    return [
      { id: 'jar', name: 'Jar', print: IDENTITY, explode: [0, 0, 0], tip: 'Print upright. The 45° thread flanks need no supports.' },
      { id: 'cap', name: 'Cap', print: rotX(180), explode: [0, 0, (R.Hcap as number) + 12], tip: 'Prints upside down, top face on the bed.' },
    ];
  },
  warnings(p, R) {
    const w = [];
    if ((R.rBore as number) < 4) w.push({ level: 'error' as const, text: 'The jar is too narrow for this wall and thread. Increase the diameter.' });
    if ((R.Hb as number) < p.floor + 3 || (R.shoulderBottom as number) < p.floor + 0.6)
      w.push({ level: 'error' as const, text: 'The jar body is too short for this cap and thread. Increase the height or shorten the thread.' });
    const td = R.td as number, c = p.threadClearance;
    if (c >= 0.75 * td)
      w.push({ level: 'error' as const, text: `A ${fmt(c)} mm clearance is too loose for a ${fmt(td)} mm deep thread: the cap would slip off. Use at most ${fmt(Math.floor(0.6 * td * 20) / 20)} mm or a deeper thread.` });
    else if (c > 0.5 * td) w.push({ level: 'warn' as const, text: 'The thread clearance is more than half the thread depth, so the cap will feel loose.' });
    if (c < 0.25) w.push({ level: 'warn' as const, text: 'Thread clearance under 0.25 mm often binds. Try 0.4 mm.' });
    if ((R.L as number) > p.threadLength + 0.01)
      w.push({ level: 'info' as const, text: `Thread length raised to ${fmt(R.L as number)} mm so the cap grips for at least one full turn at this pitch.` });
    if (p.threadDepth > td + 1e-9) w.push({ level: 'info' as const, text: `Thread depth is limited to ${fmt(td)} mm at this pitch.` });
    if (p.grip === 'knurl' && knurlDepth(p.wall) < 0.2) w.push({ level: 'info' as const, text: 'Walls under 1 mm are too thin to knurl, so the cap is smooth.' });
    if (p.wall < 1.2) w.push({ level: 'warn' as const, text: 'Walls under 1.2 mm are fragile.' });
    return w;
  },
  build(p, R) {
    const Rr = R.R as number, Hb = R.Hb as number, H = R.H as number;
    const pitch = R.pitch as number, td = R.td as number, L = R.L as number, c = R.c as number;
    const rn = R.rn as number, rc = R.rc as number, rBore = R.rBore as number, Hcap = R.Hcap as number;
    const t = p.wall, f = p.floor;
    // Jar body with a 45-degree inner shoulder up to the narrower neck bore.
    const T = threadLayout(pitch, td);
    const body = cylZ(Rr, 0, Hb);
    const turnsZ = (z: number) => ((z - Hb) / pitch) * 2 * Math.PI;
    // Neck ridge centre sits mid-crest: root flat, rising flank, half the crest.
    const neckZ0 = Hb + T.root + T.flank + T.crest / 2;
    const half = T.base / 2 + 0.3;
    const neckRidge = helicalRidge({
      rBase: rn,
      rTip: rn + td,
      baseW: T.base,
      tipW: T.tip,
      pitch,
      zAt0: neckZ0,
      phi0: turnsZ(Hb + 0.3 + half - (neckZ0 - Hb)),
      phi1: turnsZ(Hb + L - 0.3 - half - (neckZ0 - Hb)),
      embed: 0.3,
    });
    const neck = unionAll([cylZ(rn, Hb - 0.01, Hb + L), neckRidge]);
    const ri = Rr - t;
    const shoulder = Math.max(0, ri - rBore);
    const zc1 = Hb - 1.2;
    const zc0 = zc1 - shoulder;
    const cavity = unionAll([
      cylZ(ri, f, Math.max(f + 0.1, zc0 + 0.01)),
      shoulder > 0.05 ? coneZ(ri, rBore, zc0, zc1) : null,
      cylZ(rBore, zc1 - 0.01, H + 1),
    ]);
    const jarSolid = unionAll([body, neck]).subtract(cavity);
    // Cap: knurled shell with the matching internal ridge, half a pitch from the neck ridge.
    let outerCS = circle(Rr);
    const kd = knurlDepth(t);
    if (p.grip === 'knurl' && kd >= 0.2) {
      const nK = Math.max(12, Math.round((2 * Math.PI * Rr) / 3.2));
      const notches = Array.from({ length: nK }, (_, i) => {
        const a = (i / nK) * Math.PI * 2;
        return circle(0.85, 16).translate([(Rr + 0.85 - kd) * Math.cos(a), (Rr + 0.85 - kd) * Math.sin(a)]);
      });
      outerCS = outerCS.subtract(K().CrossSection.union(notches));
    }
    const top = Hb + Hcap;
    const capZ0 = Hb + T.root / 2;
    const capRidge = helicalRidge({
      rBase: rc,
      rTip: rn + c,
      baseW: T.base,
      tipW: T.tip,
      pitch,
      zAt0: capZ0,
      phi0: turnsZ(Hb + 0.2 + half - (capZ0 - Hb)),
      phi1: turnsZ(Hb + L + 0.4 - half - (capZ0 - Hb)),
      embed: 0.3,
    });
    const chamfer = coneZ(rc + 0.6, rc - td * 0.6, Hb - 0.01, Hb + 0.6 + td * 0.6);
    const cap = unionAll([prism(outerCS, Hb, top).subtract(cylZ(rc, Hb - 1, Hb + L + 0.6)), capRidge]).subtract(chamfer);
    return { jar: jarSolid, cap };
  },
};
