import { mulMat, rotZ, translation } from '../core/math';
import type { Mat4, PartMesh } from '../core/types';

export interface Printer {
  id: string;
  name: string;
  w: number;
  d: number;
  h: number;
}

export const PRINTERS: Printer[] = [
  { id: 'bed256', name: '256 × 256 mm (Bambu Lab X1, P1, A1)', w: 256, d: 256, h: 256 },
  { id: 'bed250', name: '250 × 210 mm (Prusa MK4, MK3)', w: 250, d: 210, h: 220 },
  { id: 'bed220', name: '220 × 220 mm (Ender 3 class)', w: 220, d: 220, h: 250 },
  { id: 'bed180', name: '180 × 180 mm (A1 mini, Prusa Mini)', w: 180, d: 180, h: 180 },
  { id: 'bed300', name: '300 × 300 mm (large format)', w: 300, d: 300, h: 300 },
  { id: 'bed350', name: '350 × 350 mm (Voron 350 class)', w: 350, d: 350, h: 340 },
];

export function printerById(id: string): Printer {
  return PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];
}

export interface Layout {
  /** Full matrix from the assembled pose to the bed, per part id (inlays use their parent's). */
  matrices: Map<string, Mat4>;
  overflow: string[];
  tooTall: string[];
}

const GAP = 8;

const fitsBed = (w: number, d: number, bed: Printer) => w <= bed.w + 0.01 && d <= bed.d + 0.01;

/** Footprint of a body in print orientation. */
function footprint(p: PartMesh) {
  return { w: p.printMax[0] - p.printMin[0], d: p.printMax[1] - p.printMin[1] };
}

/** A body in print orientation, turned 90° about Z or not. */
function orient(p: PartMesh, turned: boolean) {
  const { w, d } = footprint(p);
  const h = p.printMax[2] - p.printMin[2];
  // Turning by +90° maps (x, y) to (-y, x).
  if (turned) return { p, w: d, d: w, h, minX: -p.printMax[1], minY: p.printMin[0], minZ: p.printMin[2], base: mulMat(rotZ(90), p.print) };
  return { p, w, d, h, minX: p.printMin[0], minY: p.printMin[1], minZ: p.printMin[2], base: p.print };
}

type Item = ReturnType<typeof orient>;

/** Shelf-pack the bodies, deepest first: rows across the bed, front row first. */
function pack(items: Item[], bed: Printer) {
  const sorted = [...items].sort((a, b) => b.d - a.d || b.w - a.w);
  const rows: { items: Item[]; w: number; d: number }[] = [];
  for (const it of sorted) {
    const row = rows.find((r) => r.w + GAP + it.w <= bed.w);
    if (row && row.items.length) {
      row.items.push(it);
      row.w += GAP + it.w;
      row.d = Math.max(row.d, it.d);
    } else rows.push({ items: [it], w: it.w, d: it.d });
  }
  const totalD = rows.reduce((s, r) => s + r.d, 0) + GAP * Math.max(0, rows.length - 1);
  return { rows, totalD, fits: totalD <= bed.d + 0.01 && items.every((it) => fitsBed(it.w, it.d, bed)) };
}

/**
 * Lay the bodies out on the bed in print orientation, centred. Each part is turned 90° only when that is
 * the one way it fits; when the parts then do not fit together, the other ways of turning them are tried,
 * fewest turns first.
 */
export function layoutParts(parts: PartMesh[], bed: Printer): Layout {
  const bodies = parts.filter((p) => p.role === 'body');
  const mustTurn = (p: PartMesh) => !fitsBed(footprint(p).w, footprint(p).d, bed) && fitsBed(footprint(p).d, footprint(p).w, bed);
  let packed = pack(bodies.map((p) => orient(p, mustTurn(p))), bed);
  if (!packed.fits && bodies.length <= 10) {
    const turnCount = (mask: number) => bodies.reduce((n, _, i) => n + ((mask >> i) & 1), 0);
    const masks = [...Array(1 << bodies.length).keys()].sort((a, b) => turnCount(a) - turnCount(b));
    for (const mask of masks) {
      const tried = pack(bodies.map((p, i) => orient(p, ((mask >> i) & 1) === 1)), bed);
      if (tried.fits) {
        packed = tried;
        break;
      }
    }
  }
  const { rows, totalD } = packed;
  const matrices = new Map<string, Mat4>();
  const overflow: string[] = [];
  const tooTall: string[] = [];
  let y = -totalD / 2;
  for (const row of rows) {
    let x = -row.w / 2;
    for (const it of row.items) {
      const t = translation(x - it.minX, y + (row.d - it.d) / 2 - it.minY, -it.minZ);
      matrices.set(it.p.id, mulMat(t, it.base));
      if (!fitsBed(it.w, it.d, bed)) overflow.push(it.p.name);
      if (it.h > bed.h + 0.01) tooTall.push(it.p.name);
      x += it.w + GAP;
    }
    y += row.d + GAP;
  }
  if (totalD > bed.d + 0.01 && !overflow.length) overflow.push('the parts together');
  for (const p of parts) if (p.role === 'inlay' && p.parentId && matrices.has(p.parentId)) matrices.set(p.id, matrices.get(p.parentId)!);
  return { matrices, overflow, tooTall };
}

/** One print bed's worth of parts that print in the same filament. */
export interface Plate {
  /** The filament slot of its parts (their colour inlays bring their own). */
  slot: number;
  /** Body part ids on this plate; their inlays print with them. */
  bodies: string[];
  /** Placement on this plate's bed, per part id (inlays use their parent's). */
  matrices: Map<string, Mat4>;
}

export interface PlateLayout {
  plates: Plate[];
  /** Every part placed for the view: plate `k` sits `k` beds (plus a gap) along +X. */
  matrices: Map<string, Mat4>;
  /** Parts too big for any bed, or taller than the printer allows. */
  overflow: string[];
  tooTall: string[];
}

/** Space between plates shown side by side (mm). */
export const PLATE_GAP = 40;

/**
 * Put the bodies on plates. Parts of different filaments never share a plate: with an AMS, every layer
 * that holds two colours costs a filament swap. Parts of one filament share as few plates as fit them.
 */
export function layoutPlates(parts: PartMesh[], bed: Printer, slotOf: (partId: string) => number): PlateLayout {
  const bodies = parts.filter((p) => p.role === 'body');
  const withInlays = (group: PartMesh[]) => parts.filter((p) => group.includes(p) || (p.role === 'inlay' && group.some((b) => b.id === p.parentId)));
  const fits = (group: PartMesh[]) => layoutParts(withInlays(group), bed).overflow.length === 0;
  const plates: Plate[] = [];
  const overflow: string[] = [];
  const tooTall: string[] = [];
  const slots = [...new Set(bodies.map((b) => slotOf(b.id)))].sort((a, b) => a - b);
  for (const slot of slots) {
    const group = bodies.filter((b) => slotOf(b.id) === slot);
    // Largest first, each onto the first of this filament's plates it fits on.
    const area = (b: PartMesh) => (b.printMax[0] - b.printMin[0]) * (b.printMax[1] - b.printMin[1]);
    const bins: PartMesh[][] = [];
    if (fits(group)) bins.push(group);
    else
      for (const b of [...group].sort((x, y) => area(y) - area(x))) {
        const bin = bins.find((g) => fits([...g, b]));
        if (bin) bin.push(b);
        else bins.push([b]);
      }
    for (const bin of bins) {
      const ordered = group.filter((b) => bin.includes(b));
      const L = layoutParts(withInlays(ordered), bed);
      overflow.push(...L.overflow);
      tooTall.push(...L.tooTall);
      plates.push({ slot, bodies: ordered.map((b) => b.id), matrices: L.matrices });
    }
  }
  const matrices = new Map<string, Mat4>();
  plates.forEach((plate, k) => {
    const shift = translation(k * (bed.w + PLATE_GAP), 0, 0);
    for (const [id, m] of plate.matrices) matrices.set(id, mulMat(shift, m));
  });
  return { plates, matrices, overflow, tooTall };
}

/** Matrix that sits one part alone on the bed origin (used for single-part STL files). */
export function soloMatrix(p: PartMesh): Mat4 {
  const cx = (p.printMin[0] + p.printMax[0]) / 2;
  const cy = (p.printMin[1] + p.printMax[1]) / 2;
  return mulMat(translation(-cx, -cy, -p.printMin[2]), p.print);
}
