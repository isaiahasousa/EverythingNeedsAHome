import type { Manifold } from 'manifold-3d';
import { IDENTITY } from '../core/math';
import { box, cylZ, loftRoundedRect, profileYZ, prism, rrect, unionAll } from '../geometry/kernel';
import type { BoxParams, FaceDef, Resolved } from '../core/types';
import { cavityRoom, planeFace, wallFaces, type BoxType } from './common';
import { dividerCentres } from './tray';

// Gridfinity reference dimensions (42 mm grid, 7 mm height units).
export const GF = {
  pitch: 42,
  gap: 0.5,
  radius: 3.75,
  baseHeight: 7,
  profileHeight: 4.75,
  // The reference lip is 4.4 mm to a knife edge; we stop at 4.0 mm with a 0.4 mm flat that prints cleanly.
  lipHeight: 4.0,
  magnetR: 6.5 / 2,
  magnetDepth: 2.4,
  magnetOffset: 13,
};

function resolve(p: BoxParams): Resolved {
  const nx = Math.max(1, Math.round(p.gfX));
  const ny = Math.max(1, Math.round(p.gfY));
  const nz = Math.max(2, Math.round(p.gfZ));
  const W = GF.pitch * nx - GF.gap;
  const D = GF.pitch * ny - GF.gap;
  const Hbody = 7 * nz;
  const H = Hbody + (p.gfLip ? GF.lipHeight : 0);
  const tw = Math.max(0.8, Math.min(2.4, p.gfWall));
  const label = p.gfLabel && nz >= 3;
  // The stacking lip's 45-degree support starts here; above it the wall is thicker than tw.
  const lipSupport = Hbody - 1.2 - (2.6 - tw);
  const faceTop = p.gfLip ? lipSupport - 0.3 : Hbody - 0.5;
  // Label shelf along the back: top surface, underside start, and how far forward it reaches.
  const shelfDepth = 12;
  const shelfTop = Hbody - (p.gfLip ? 1.2 : 0);
  const shelfBottom = shelfTop - shelfDepth - 1.2;
  const shelfFrontY = D / 2 - tw + 0.3 - shelfDepth;
  // Inside height is full-width space: with the stacking lip it ends where the lip's support starts.
  const insideTop = p.gfLip ? lipSupport : Hbody;
  return { outer: [W, D, H], inner: [W - 2 * tw, D - 2 * tw, insideTop - GF.baseHeight], nx, ny, nz, W, D, Hbody, H, tw, label, faceTop, shelfDepth, shelfTop, shelfBottom, shelfFrontY };
}

/** Row dividers that would be sealed in under the label shelf are left out. */
function rowDividers(p: BoxParams, R: Resolved) {
  const D = R.D as number, tw = R.tw as number, dt = 1.2;
  const all = dividerCentres(D - 2 * tw, Math.round(p.gfDividersY), dt);
  const keep = R.label ? all.filter((y) => y + dt / 2 < (R.shelfFrontY as number)) : all;
  return { keep, dropped: all.length - keep.length };
}

export const gridfinity: BoxType = {
  id: 'gridfinity',
  name: 'Gridfinity bin',
  tagline: 'Fits the Gridfinity 42 mm storage grid, stackable.',
  dims: [
    { kind: 'int', key: 'gfX', label: 'Grid units wide', min: 1, max: 8, help: 'Each unit is 42 mm.' },
    { kind: 'int', key: 'gfY', label: 'Grid units deep', min: 1, max: 8 },
    { kind: 'int', key: 'gfZ', label: 'Height units', min: 2, max: 20, help: 'Each unit is 7 mm, including the 7 mm base.' },
    { kind: 'length', key: 'gfWall', label: 'Wall thickness', min: 0.8, max: 2.4, step: 0.05 },
  ],
  usesDimsMode: false,
  groups: [
    {
      title: 'Bin',
      params: [
        { kind: 'toggle', key: 'gfLip', label: 'Stacking lip', help: 'Lets another bin stack on top.' },
        { kind: 'toggle', key: 'gfMagnets', label: 'Magnet holes', help: '6 x 2 mm magnets, four per grid cell.' },
        { kind: 'toggle', key: 'gfLabel', label: 'Label shelf', help: 'Angled shelf along the back for a label strip.' },
        { kind: 'int', key: 'gfDividersX', label: 'Columns', min: 1, max: 12 },
        { kind: 'int', key: 'gfDividersY', label: 'Rows', min: 1, max: 12 },
      ],
    },
  ],
  resolve,
  faces(p, R) {
    const W = R.W as number, D = R.D as number, tw = R.tw as number;
    // Faces stop below the stacking lip, and the back face below the label shelf, so the wall
    // behind every face really is `tw` thick (cut-through graphics go all the way).
    const bottom = GF.profileHeight + 0.6;
    const top = R.faceTop as number;
    // Bins sit 0.25 mm apart on the grid: anything raised further on the outside hits the neighbour.
    const gridFit = { max: GF.gap / 2, why: 'the bin will no longer fit its grid beside other bins' };
    const walls = (which: ('front' | 'back' | 'left' | 'right')[], z1: number) =>
      wallFaces('bin', W, D, bottom, z1, GF.radius, tw, '', '', which).map((f) => ({ ...f, raiseLimit: gridFit, innerRoom: cavityRoom(R) }));
    const faces: FaceDef[] = walls(['front', 'left', 'right'], top);
    const backTop = R.label ? Math.min(top, (R.shelfBottom as number) - 0.3) : top;
    if (backTop - bottom >= 5) faces.push(...walls(['back'], backTop));
    if (R.label) {
      // From just behind the shelf's front edge to the back wall, or to the stacking lip that overhangs it.
      const front = (R.shelfFrontY as number) + 0.5;
      const back = p.gfLip ? D / 2 - 2.6 - 0.3 : D / 2 - tw - 0.3;
      // The shelf is a solid wedge (its 45-degree support fills in underneath): engrave it, never cut it.
      faces.push(
        planeFace('label', 'Label shelf', 'bin', [0, (front + back) / 2, R.shelfTop as number], [1, 0, 0], [0, 1, 0], [0, 0, 1], W - 2 * tw - 6, back - front, 1.2, {
          solid: true,
          // A bin stacked on top seats 0.35 mm below the body top, so 0.85 mm above the shelf.
          raiseLimit: p.gfLip ? { max: 0.8, why: 'a bin stacked on top would sit on them' } : undefined,
        }),
      );
    }
    return faces;
  },
  parts() {
    return [{ id: 'bin', name: 'Bin', print: IDENTITY, explode: [0, 0, 0], tip: 'Print upright. The base profile is self-supporting.' }];
  },
  warnings(p, R) {
    const w = [];
    if (p.gfWall < 1.0) w.push({ level: 'warn' as const, text: 'Walls under 1 mm are fragile; the Gridfinity minimum is 0.95 mm.' });
    if (p.gfLabel && Math.round(p.gfZ) < 3) w.push({ level: 'info' as const, text: 'The label shelf needs a bin at least 3 units tall.' });
    const { dropped } = rowDividers(p, R);
    if (dropped > 0) w.push({ level: 'info' as const, text: `${dropped === 1 ? 'One row divider' : `${dropped} row dividers`} would sit under the label shelf, so the back compartment is merged with the next one.` });
    return w;
  },
  build(p, R) {
    const nx = R.nx as number, ny = R.ny as number;
    const W = R.W as number, D = R.D as number, Hbody = R.Hbody as number, H = R.H as number, tw = R.tw as number;
    const r = GF.radius;
    const feet: Manifold[] = [];
    const holes: Manifold[] = [];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const cx = -((nx - 1) * GF.pitch) / 2 + i * GF.pitch;
        const cy = -((ny - 1) * GF.pitch) / 2 + j * GF.pitch;
        const foot = loftRoundedRect(41.5, 41.5, r, [
          { inset: 2.95, z: 0 },
          { inset: 2.15, z: 0.8 },
          { inset: 2.15, z: 2.6 },
          { inset: 0, z: GF.profileHeight },
        ]);
        feet.push(foot.translate([cx, cy, 0]));
        if (p.gfMagnets)
          for (const sx of [-1, 1])
            for (const sy of [-1, 1]) holes.push(cylZ(GF.magnetR, -0.01, GF.magnetDepth, cx + sx * GF.magnetOffset, cy + sy * GF.magnetOffset));
      }
    let bin = unionAll([...feet, prism(rrect(W, D, r), GF.profileHeight - 0.01, H)]);
    const floorZ = GF.baseHeight;
    let cavity: Manifold;
    if (p.gfLip) {
      const supStart = Hbody - 1.2 - (2.6 - tw);
      cavity = loftRoundedRect(W, D, r, [
        { inset: tw, z: floorZ },
        { inset: tw, z: Math.max(floorZ + 0.1, supStart) },
        { inset: 2.6, z: Hbody - 1.2 },
        { inset: 2.6, z: Hbody },
        { inset: 1.9, z: Hbody + 0.7 },
        { inset: 1.9, z: Hbody + 2.5 },
        { inset: 0.4, z: Hbody + 4.0 },
        { inset: 0.4, z: H + 1 },
      ]);
    } else {
      cavity = prism(rrect(W - 2 * tw, D - 2 * tw, r - tw), floorZ, H + 1);
    }
    bin = bin.subtract(cavity);
    const iw = W - 2 * tw, id = D - 2 * tw, dt = 1.2;
    // With a label shelf the dividers stop at its top surface so a label strip lies flat. With the
    // stacking lip they stop under the feet of a stacked bin, which seat 0.35 mm below the body top.
    const divTop = R.label ? (R.shelfTop as number) : p.gfLip ? Hbody - 0.5 : Hbody;
    const slabs = [
      ...dividerCentres(iw, Math.round(p.gfDividersX), dt).map((x) => box(x - dt / 2, x + dt / 2, -id / 2 - tw / 2, id / 2 + tw / 2, floorZ - 0.01, divTop)),
      ...rowDividers(p, R).keep.map((y) => box(-iw / 2 - tw / 2, iw / 2 + tw / 2, y - dt / 2, y + dt / 2, floorZ - 0.01, divTop)),
    ];
    if (R.label) {
      // Shelf along the back wall with a 45-degree support underneath (prints without supports).
      const depth = R.shelfDepth as number;
      const h = depth + 1.2;
      const yw = D / 2 - tw + 0.3;
      const zt = R.shelfTop as number;
      slabs.push(profileYZ([[yw, zt - h], [yw, zt], [yw - depth, zt], [yw - depth, zt - 1.2]], -iw / 2 - 0.3, iw / 2 + 0.3));
    }
    // Dividers and shelf reach into the walls; clip them halfway in so nothing pokes out of a rounded corner.
    if (slabs.length) bin = unionAll([bin, unionAll(slabs).intersect(prism(rrect(W - tw, D - tw, r - tw / 2), floorZ - 0.02, H))]);
    if (holes.length) bin = bin.subtract(unionAll(holes));
    return { bin };
  },
};
