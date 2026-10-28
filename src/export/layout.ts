import { mulMat, translation } from '../core/math';
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

/** Shelf-pack the bodies on the bed in print orientation, centred, front row first. */
export function layoutParts(parts: PartMesh[], bed: Printer): Layout {
  const bodies = parts.filter((p) => p.role === 'body');
  const items = bodies
    .map((p) => ({ p, w: p.printMax[0] - p.printMin[0], d: p.printMax[1] - p.printMin[1], h: p.printMax[2] - p.printMin[2] }))
    .sort((a, b) => b.d - a.d || b.w - a.w);
  const rows: { items: typeof items; w: number; d: number }[] = [];
  for (const it of items) {
    const row = rows.find((r) => r.w + GAP + it.w <= bed.w);
    if (row && row.items.length) {
      row.items.push(it);
      row.w += GAP + it.w;
      row.d = Math.max(row.d, it.d);
    } else rows.push({ items: [it], w: it.w, d: it.d });
  }
  const totalD = rows.reduce((s, r) => s + r.d, 0) + GAP * Math.max(0, rows.length - 1);
  const matrices = new Map<string, Mat4>();
  const overflow: string[] = [];
  const tooTall: string[] = [];
  let y = -totalD / 2;
  for (const row of rows) {
    let x = -row.w / 2;
    for (const it of row.items) {
      const t = translation(x - it.p.printMin[0], y + (row.d - it.d) / 2 - it.p.printMin[1], -it.p.printMin[2]);
      matrices.set(it.p.id, mulMat(t, it.p.print));
      if (it.w > bed.w + 0.01 || it.d > bed.d + 0.01) overflow.push(it.p.name);
      if (it.h > bed.h + 0.01) tooTall.push(it.p.name);
      x += it.w + GAP;
    }
    y += row.d + GAP;
  }
  if (totalD > bed.d + 0.01 && !overflow.length) overflow.push('the parts together');
  for (const p of parts) if (p.role === 'inlay' && p.parentId && matrices.has(p.parentId)) matrices.set(p.id, matrices.get(p.parentId)!);
  return { matrices, overflow, tooTall };
}

/** Matrix that sits one part alone on the bed origin (used for single-part STL files). */
export function soloMatrix(p: PartMesh): Mat4 {
  const cx = (p.printMin[0] + p.printMax[0]) / 2;
  const cy = (p.printMin[1] + p.printMax[1]) / 2;
  return mulMat(translation(-cx, -cy, -p.printMin[2]), p.print);
}
