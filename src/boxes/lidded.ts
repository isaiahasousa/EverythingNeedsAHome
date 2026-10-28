import type { CrossSection, Manifold } from 'manifold-3d';
import { IDENTITY, rotX } from '../core/math';
import { K, prism, rrect, segs, unionAll } from '../geometry/kernel';
import type { BoxParams, FaceDef, LidStyle, Resolved, Vec2, Warning } from '../core/types';
import { bottomFace, cavityRoom, ceilTo, clampRadius, commonWarnings, EPS, F, floorRoom, fmt, rectDims, topFace, topNotchOutline, wallFaces, withRoom, type BoxType } from './common';

export interface SideAnchor {
  /** Point on the outer face at the middle of a straight side, and its outward normal. */
  p: Vec2;
  n: Vec2;
  len: number;
}

export interface LidShellOpts {
  /** Outer outline inset inward by `inset` mm (negative = outset). */
  outline: (inset: number) => CrossSection;
  H: number;
  t: number;
  f: number;
  lt: number;
  Hl: number;
  lipH: number;
  lipT: number;
  tol: number;
  /** Flush step: thickness of the neck left standing on the box walls. */
  neck: number;
  style: LidStyle;
  snap: boolean;
  sides: SideAnchor[];
}

/** Effective numbers for a lid design, shared by faces, builders and warnings. */
export function lidLayout(p: BoxParams, H: number) {
  const style = p.lidStyle;
  const t = p.wall, tol = p.tolerance;
  const lt = Math.min(p.lidTop, p.lidHeight);
  const Hl = Math.max(p.lidHeight, lt);
  const Hb = style === 'cap' ? H - lt - 0.3 : H - Hl;
  // Flush step: split the wall between the box's neck and the lid's skirt so both stay printable.
  const maxNeck = t - tol - 0.8;
  const neck = maxNeck >= 0.6 ? Math.max(0.6, Math.min(p.lipThickness, maxNeck)) : Math.max(0.2, (t - tol) / 2);
  let lipH = p.lipHeight;
  // Flush step: the neck has to fit under the lid top with clearance (an error below 1 mm).
  if (style === 'rabbet') lipH = Math.min(lipH, Hl - lt - 0.3);
  // Inset plug: the lip has to stop above the floor of the box.
  if (style === 'plug') lipH = Math.max(0.5, Math.min(lipH, Hb - p.floor - tol - 0.4));
  // Wall thickness behind the lid's side faces.
  const skirt = style === 'plug' ? t + tol + p.lipThickness : style === 'rabbet' ? t - neck - tol : t;
  return { style, lt, Hl, lipH, Hb, neck, skirt };
}

/** Snap bump length on a straight side of length `len` (0 when the side is too short for one). */
export function snapLength(len: number) {
  const L = Math.min(0.35 * len, 24);
  return L < 4 ? 0 : L;
}

/**
 * Snap grooves are cut into the inside of the box walls, so faces must keep graphics off them:
 * the notch (in face coordinates, down from the top edge) to leave out, or null when there is none.
 */
export function snapNotch(p: BoxParams, R: Resolved, sideLen: number): { halfW: number; depth: number } | null {
  const lipH = R.lipH as number;
  const L = snapLength(sideLen);
  if (!p.snap || R.style !== 'plug' || lipH < 3 || L === 0) return null;
  return { halfW: (L + 1.2) / 2 + 0.3, depth: lipH / 2 + SNAP_GROOVE_R + 0.3 };
}

const SNAP_BUMP_R = 1.2;
const SNAP_BUMP_OUT = 0.5;
const SNAP_GROOVE_R = SNAP_BUMP_R + 0.15;
/** How far a snap groove reaches into the box wall for fit clearance `tol`. */
export const snapGrooveDepth = (tol: number) => Math.max(0, SNAP_GROOVE_R - (SNAP_BUMP_R - SNAP_BUMP_OUT) - tol);

/**
 * Advice when a lip running inside the walls leaves no room in the middle: the thickest lip that fits,
 * or (when even the thinnest lip does not fit) how big the box has to be.
 */
export function lipTooThick(span: number, p: BoxParams, otherwise: string) {
  const maxLip = Math.floor(((span - 2 - 2 * (p.wall + p.tolerance)) / 2) * 10 + EPS) / 10;
  if (maxLip >= 0.8) return `The lid's lip is too thick for a box this small. Use a lip thickness of at most ${fmt(maxLip)} mm, or a larger box.`;
  return `The box is too small for a lid lip with these walls. Make it at least ${fmt(ceilTo(2 + 2 * (p.wall + p.tolerance + 0.8), 0.5))} mm across, or ${otherwise}.`;
}

/** Smallest width or depth across the box, for checks on lips that reach inside it. */
const minSpan = (R: Resolved) => (typeof R.minSpan === 'number' ? R.minSpan : Math.min(R.W as number, R.D as number));

export function buildLidShell(o: LidShellOpts): { base: Manifold; lid: Manifold } {
  const { outline, H, t, f, lt, Hl, tol, lipT } = o;
  const { Manifold } = K();
  let base: Manifold;
  let lid: Manifold;
  if (o.style === 'cap') {
    const Hbase = H - lt - 0.3;
    base = prism(outline(0), 0, Hbase).subtract(prism(outline(t), f, H + 1));
    lid = prism(outline(-(tol + t)), H - Hl, H);
    if (H - lt > H - Hl + 0.01) lid = lid.subtract(prism(outline(-tol), H - Hl - 1, H - lt));
  } else if (o.style === 'rabbet') {
    const Hb = H - Hl;
    const lipH = o.lipH;
    const tn = o.neck;
    base = unionAll([prism(outline(0), 0, Hb), prism(outline(t - tn), Hb - 0.02, Hb + lipH)]).subtract(prism(outline(t), f, H + 1));
    lid = prism(outline(0), Hb, H);
    if (H - lt > Hb + 0.01) lid = lid.subtract(prism(outline(t - tn - tol), Hb - 1, H - lt));
  } else {
    const Hb = H - Hl;
    base = prism(outline(0), 0, Hb).subtract(prism(outline(t), f, Hb + 1));
    const inner = outline(t + tol + lipT);
    lid = prism(outline(0), Hb, H);
    if (H - lt > Hb + 0.01) lid = lid.subtract(prism(inner, Hb - 1, H - lt));
    const plug = prism(outline(t + tol), Hb - o.lipH, Hb + 0.02).subtract(prism(inner, Hb - o.lipH - 1, Hb + 1));
    lid = unionAll([lid, plug]);
    if (o.snap && o.lipH >= 3) {
      const rb = SNAP_BUMP_R, s = SNAP_BUMP_OUT;
      const zc = Hb - o.lipH * 0.5;
      const bumps: Manifold[] = [];
      const grooves: Manifold[] = [];
      for (const side of o.sides) {
        const L = snapLength(side.len);
        if (L === 0) continue;
        const face: Vec2 = [side.p[0] - side.n[0] * (t + tol), side.p[1] - side.n[1] * (t + tol)];
        const c: Vec2 = [face[0] - side.n[0] * (rb - s), face[1] - side.n[1] * (rb - s)];
        const ang = (Math.atan2(side.n[0], -side.n[1]) * 180) / Math.PI; // tangent direction
        const cyl = (r: number, len: number) =>
          Manifold.cylinder(len, r, r, segs(r), true).rotate([0, 90, ang]).translate([c[0], c[1], zc]);
        bumps.push(cyl(rb, L));
        grooves.push(cyl(SNAP_GROOVE_R, L + 1.2));
      }
      if (bumps.length) {
        // Keep bumps on the outside of the plug only.
        lid = unionAll([lid, Manifold.union(bumps).subtract(prism(inner, Hb - o.lipH - 1, Hb + 1))]);
        base = base.subtract(Manifold.union(grooves));
      }
    }
  }
  return { base, lid };
}

function resolve(p: BoxParams): Resolved {
  // Inside sizes are usable space. An inset plug lid is narrower than the box all the way up (its lip
  // hangs inside the walls), so the full-width space ends where the lip starts.
  const lt = Math.min(p.lidTop, p.lidHeight);
  const aboveInside = p.lidStyle === 'plug' ? p.lipHeight + Math.max(p.lidHeight, lt) : lt;
  const { W, D, H } = rectDims(p, p.floor + aboveInside);
  const r = clampRadius(p.radius, W, D);
  const L = lidLayout(p, H);
  const capGrow = L.style === 'cap' ? 2 * (p.tolerance + p.wall) : 0;
  return {
    outer: [W + capGrow, D + capGrow, H],
    inner: [W - 2 * p.wall, D - 2 * p.wall, L.style === 'plug' ? L.Hb - L.lipH - p.floor : H - p.floor - L.lt],
    r,
    W,
    D,
    H,
    minSpan: Math.min(W, D),
    clearH: H - p.floor - L.lt,
    ...L,
  };
}

export function lidWarnings(p: BoxParams, R: Resolved): Warning[] {
  const w: Warning[] = [];
  const style = R.style as LidStyle;
  const Hl = R.Hl as number, lt = R.lt as number, lipH = R.lipH as number;
  const neck = R.neck as number, skirt = R.skirt as number;
  const H = R.H as number;
  if ((R.Hb as number) < p.floor + 2 - EPS) {
    w.push({ level: 'error', text: 'The lid is taller than the box. Reduce the lid height or make the box taller.' });
    return w;
  }
  if (style === 'cap' && Hl > H + EPS) {
    w.push({ level: 'error', text: `The cap would reach below the bottom of the box. Make the lid height at most ${fmt(Math.floor(H * 2) / 2)} mm.` });
    return w;
  }
  if (style === 'cap') {
    // The cap's skirt has to come down over the top of the box (which stops 0.3 mm under the cap top).
    const grip = Hl - lt - 0.3;
    if (grip < 1 - EPS) {
      w.push({ level: 'error', text: `A cap this short would only rest on the box. Make the lid at least ${fmt(ceilTo(p.lidTop + 1.3, 0.5))} mm tall so it slips over the box.` });
      return w;
    }
    if (grip < 2 - EPS) w.push({ level: 'warn', text: `The cap only overlaps the box by ${fmt(grip)} mm and will come off easily. Make the lid taller.` });
  }
  if (style === 'rabbet') {
    if (lipH < 1 - EPS) {
      w.push({
        level: 'error',
        text:
          p.lipHeight < 1 - EPS
            ? 'A flush lid needs a lip depth of at least 1 mm to hold onto the box. Increase Lip depth.'
            : `A flush lid this short cannot cover the box's neck. Make the lid at least ${fmt(ceilTo(p.lidTop + 1.3, 0.5))} mm tall, or choose another lid style.`,
      });
      return w;
    }
    // The wall is split into the box's neck, the clearance and the lid's skirt; each needs a printed line.
    if (skirt < 0.4 - EPS || neck < 0.4 - EPS) {
      w.push({ level: 'error', text: `The walls are too thin for a flush lid with ${fmt(p.tolerance)} mm of clearance. Use walls of at least ${fmt(ceilTo(0.8 + p.tolerance, 0.1))} mm, less clearance, or another lid style.` });
      return w;
    }
    if (skirt < 0.8 - EPS || neck < 0.8 - EPS)
      w.push({ level: 'warn', text: `The flush step leaves a ${fmt(neck)} mm neck and a ${fmt(skirt)} mm lid skirt. Walls of at least ${fmt(1.6 + p.tolerance)} mm keep both sturdy.` });
    if (lipH < 2 - EPS) w.push({ level: 'warn', text: 'A neck shorter than 2 mm will barely hold the lid in place. Make the lid taller.' });
    if (lipH < p.lipHeight - 0.01) w.push({ level: 'info', text: `Lip depth limited to ${fmt(lipH)} mm by the lid height.` });
  }
  if (style === 'plug') {
    // The lid's lip runs inside the walls; it needs room in the middle.
    const room = minSpan(R) - 2 * (p.wall + p.tolerance + p.lipThickness);
    if (room < 2 - EPS) {
      w.push({ level: 'error', text: lipTooThick(minSpan(R), p, 'choose another lid style') });
      return w;
    }
    if (lipH < p.lipHeight - 0.01) w.push({ level: 'info', text: `Lip depth limited to ${fmt(lipH)} mm so it clears the floor of the box.` });
    if (lipH < 2 - EPS) w.push({ level: 'warn', text: 'A lip shorter than 2 mm will not hold the lid in place.' });
    if (p.snap && lipH >= 3 && p.wall - snapGrooveDepth(p.tolerance) < 0.8 - EPS)
      w.push({ level: 'warn', text: `The snap grooves leave only ${fmt(p.wall - snapGrooveDepth(p.tolerance))} mm of wall. Use walls of at least ${fmt(0.8 + snapGrooveDepth(p.tolerance))} mm or turn off snap bumps.` });
  }
  if (p.snap && style !== 'plug') w.push({ level: 'info', text: 'Snap bumps are only added to the inset plug lid.' });
  return w;
}

export const lidGroup = {
  title: 'Lid',
  params: [
    {
      kind: 'select',
      key: 'lidStyle',
      label: 'Lid style',
      options: [
        { value: 'plug', label: 'Inset plug' },
        { value: 'rabbet', label: 'Flush step' },
        { value: 'cap', label: 'Slip-over cap' },
      ],
      help: 'Plug: a lip on the lid fits inside the walls. Flush step: the walls step in and the lid sits flush. Cap: the lid slides over the outside.',
    },
    { kind: 'length', key: 'lidHeight', label: 'Lid height', min: 1, max: 200, step: 0.5 },
    { kind: 'length', key: 'lidTop', label: 'Lid top thickness', min: 0.6, max: 10, step: 0.1 },
    { kind: 'length', key: 'lipHeight', label: 'Lip depth', min: 0.5, max: 40, step: 0.5 },
    { kind: 'length', key: 'lipThickness', label: 'Lip thickness', min: 0.8, max: 6, step: 0.1 },
    F.tolerance,
    { kind: 'toggle', key: 'snap', label: 'Snap bumps', help: 'Adds small bumps to the plug and matching grooves inside the walls so the lid clicks shut.' },
  ],
} as const;

export const lidded: BoxType = {
  id: 'lidded',
  name: 'Box with lid',
  tagline: 'Separate lid: inset plug, flush step or slip-over cap.',
  dims: [F.width, F.depth, F.height, F.wall, F.floor, F.radius],
  usesDimsMode: true,
  groups: [lidGroup as unknown as BoxType['groups'][number]],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number;
    const Hb = R.Hb as number, Hl = R.Hl as number, lt = R.lt as number;
    const style = R.style as LidStyle;
    const faces: FaceDef[] = [];
    // Lithophanes may reach inward only where nothing mates behind the wall: not where a plug lip sits
    // inside the box walls, nor where a cap or flush lid's skirt wraps the box.
    const open = cavityRoom(R);
    const lipH = R.lipH as number;
    // Under the lid top: a plug lid's own cavity; above a flush lid's neck, what the neck leaves; a cap
    // sits right on the box.
    const topRoom = style === 'plug' ? Math.max(0, Hl - lt - 0.5) : style === 'rabbet' ? Math.max(0, Hl - lt - lipH - 0.5) : 0;
    if (style === 'cap') {
      const g = p.tolerance + p.wall;
      faces.push(...withRoom(wallFaces('base', W, D, 0, Math.max(1, H - Hl - 0.6), r, p.wall), open));
      faces.push(topFace('lid-top', 'Lid top', 'lid', W + 2 * g, D + 2 * g, r + g, H, lt, true));
      if (Hl - lt >= 5) faces.push(...wallFaces('lid', W + 2 * g, D + 2 * g, H - Hl, H, r + g, R.skirt as number, 'lid-', 'Lid'));
    } else {
      // Keep graphics off the snap grooves cut into the inside of the walls.
      for (const f of wallFaces('base', W, D, 0, Hb, r, p.wall, '', '', undefined)) {
        const notch = snapNotch(p, R, f.width);
        const face = notch ? { ...f, outline: topNotchOutline(f.width, f.height, { kind: 'rect', ...notch }) } : f;
        // A plug's lip comes down inside the top of the walls: the room only counts below it.
        faces.push(style === 'plug' ? { ...face, innerRoom: open, roomTop: Hb / 2 - lipH - 0.3 } : { ...face, innerRoom: open });
      }
      faces.push({ ...topFace('lid-top', 'Lid top', 'lid', W, D, r, H, lt, true), innerRoom: topRoom });
      if (Hl - lt >= 5 && (R.skirt as number) >= 0.4) {
        const lidWalls = wallFaces('lid', W, D, Hb, H, r, R.skirt as number, 'lid-', 'Lid');
        faces.push(...(style === 'plug' ? withRoom(lidWalls, open) : lidWalls));
      }
    }
    faces.push({ ...bottomFace('base', W, D, r, p.floor), innerRoom: floorRoom(R) });
    return faces;
  },
  parts(_p, R) {
    const Hl = R.Hl as number;
    return [
      { id: 'base', name: 'Box', print: IDENTITY, explode: [0, 0, 0], tip: 'Print upright. No supports needed.' },
      { id: 'lid', name: 'Lid', print: rotX(180), explode: [0, 0, Hl + 14], tip: 'Prints upside down, top face on the bed.' },
    ];
  },
  warnings(p, R) {
    return [...commonWarnings(p, R), ...lidWarnings(p, R)];
  },
  build(p, R) {
    const W = R.W as number, D = R.D as number, H = R.H as number;
    const r = R.r as number;
    const sides: SideAnchor[] = [
      { p: [0, -D / 2], n: [0, -1], len: W - 2 * r },
      { p: [0, D / 2], n: [0, 1], len: W - 2 * r },
      { p: [-W / 2, 0], n: [-1, 0], len: D - 2 * r },
      { p: [W / 2, 0], n: [1, 0], len: D - 2 * r },
    ];
    const { base, lid } = buildLidShell({
      outline: (i) => rrect(W - 2 * i, D - 2 * i, Math.max(0, r - i)),
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
