// Applies placed graphics to part solids: emboss, deboss, cut-through, colour inlays and lithophanes,
// on flat faces (affine transform) and cylindrical faces (true wrap via warp).
import type { CrossSection, Manifold } from 'manifold-3d';
import { frameMatrix } from '../core/math';
import type { FaceDef, PlacedGraphic, Vec2, Warning } from '../core/types';
import { K, poly, transformed, unionAll } from './kernel';

const OVERLAP = 0.3;

export interface GraphicsOutcome {
  solids: Record<string, Manifold>;
  /** Separate colour bodies keyed by `${partId}::${color}`. */
  inlays: Record<string, { partId: string; color: string; solid: Manifold }>;
  /** originalID -> colour, for painting graphic triangles in the preview. */
  colorIds: Map<number, string>;
  warnings: Warning[];
}

function layersToCS(g: PlacedGraphic): CrossSection | null {
  const { CrossSection } = K();
  const parts: CrossSection[] = [];
  for (const layer of g.layers) {
    const rings = layer.rings.filter((r) => r.length >= 3);
    if (!rings.length) continue;
    parts.push(CrossSection.ofPolygons(rings as [number, number][][], layer.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero'));
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : CrossSection.union(parts);
}

/** Map a solid built in face coordinates (x = u, y = v, z = outward) onto the face. */
function placeOnFace(local: Manifold, face: FaceDef): Manifold {
  if (face.kind === 'plane') return transformed(local, frameMatrix(face.u, face.v, face.n, face.origin));
  const R = face.radius ?? 1;
  const a0 = face.angle0 ?? -Math.PI / 2;
  const [ox, oy, oz] = face.origin;
  return local.refineToLength(1.2).warp((p) => {
    const phi = a0 + p[0] / R;
    const r = R + p[2];
    const h = p[1];
    p[0] = ox + r * Math.cos(phi);
    p[1] = oy + r * Math.sin(phi);
    p[2] = oz + h;
  });
}

function slab(cs: CrossSection, w0: number, w1: number): Manifold {
  return cs.extrude(w1 - w0).translate([0, 0, w0]);
}

function rectCS(w: number, h: number, x: number, y: number, rot: number): CrossSection {
  return K().CrossSection.square([w, h], true).rotate(rot).translate([x, y]);
}

/** Closed heightfield slab: flat at w = 0, relief down to w = -thickness(u, v). */
function lithophane(g: PlacedGraphic): Manifold | null {
  const L = g.litho;
  if (!L || L.pw < 2 || L.ph < 2) return null;
  const { pw, ph, pixels, min, max } = L;
  const { w, h, rotation, mirror } = g.frame;
  const n = pw * ph;
  const verts = new Float32Array(n * 2 * 3);
  for (let j = 0; j < ph; j++)
    for (let i = 0; i < pw; i++) {
      const u = -w / 2 + (w * i) / (pw - 1);
      const v = -h / 2 + (h * j) / (ph - 1);
      const si = mirror ? pw - 1 - i : i;
      const lum = pixels[(ph - 1 - j) * pw + si] / 255;
      const t = min + (1 - lum) * (max - min);
      const k = j * pw + i;
      verts.set([u, v, 0], k * 3);
      verts.set([u, v, -t], (n + k) * 3);
    }
  const T = (i: number, j: number) => j * pw + i;
  const B = (i: number, j: number) => n + j * pw + i;
  const tris: number[] = [];
  for (let j = 0; j < ph - 1; j++)
    for (let i = 0; i < pw - 1; i++) {
      tris.push(T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j), T(i + 1, j + 1), T(i, j + 1));
      tris.push(B(i, j), B(i + 1, j + 1), B(i + 1, j), B(i, j), B(i, j + 1), B(i + 1, j + 1));
    }
  // Boundary loop, counter-clockwise seen from outside (+w).
  const loop: [number, number][] = [];
  for (let i = 0; i < pw - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < ph - 1; j++) loop.push([pw - 1, j]);
  for (let i = pw - 1; i > 0; i--) loop.push([i, ph - 1]);
  for (let j = ph - 1; j > 0; j--) loop.push([0, j]);
  for (let k = 0; k < loop.length; k++) {
    const [i0, j0] = loop[k];
    const [i1, j1] = loop[(k + 1) % loop.length];
    tris.push(T(i0, j0), B(i0, j0), B(i1, j1), T(i0, j0), B(i1, j1), T(i1, j1));
  }
  const { Mesh, Manifold } = K();
  const mesh = new Mesh({ numProp: 3, vertProperties: verts, triVerts: new Uint32Array(tris) });
  const m = Manifold.ofMesh(mesh);
  return m.rotate([0, 0, rotation]).translate([g.frame.x, g.frame.y, 0]);
}

export function applyGraphics(
  solids: Record<string, Manifold>,
  faces: FaceDef[],
  graphics: PlacedGraphic[],
): GraphicsOutcome {
  const out: GraphicsOutcome = { solids: { ...solids }, inlays: {}, colorIds: new Map(), warnings: [] };
  const faceById = new Map(faces.map((f) => [f.id, f]));
  /** Face labels with graphics, per part, for the loose-piece warning. */
  const touched = new Map<string, Set<string>>();
  for (const g of graphics) {
    const face = faceById.get(g.faceId);
    if (!face) continue;
    const base = out.solids[face.partId];
    if (!base) continue;
    const label = `“${face.label}”`;
    if (!touched.has(face.partId)) touched.set(face.partId, new Set());
    touched.get(face.partId)!.add(label);
    try {
      if (face.solid && (g.mode === 'cut' || g.mode === 'lithophane')) {
        out.warnings.push({ scope: 'graphics', level: 'warn', text: `${label} is solid underneath, so a graphic there cannot cut through or be a lithophane. Engrave it instead.` });
        continue;
      }
      if (face.outline.length < 3) {
        out.warnings.push({ scope: 'graphics', level: 'warn', text: `There is no room for graphics on ${label} with these settings, so one was skipped.` });
        continue;
      }
      const outline = poly(face.outline as Vec2[]);
      if (g.mode === 'lithophane') {
        const relief = lithophane(g);
        if (!relief) continue;
        let window = rectCS(g.frame.w, g.frame.h, g.frame.x, g.frame.y, g.frame.rotation);
        if (outline) window = window.intersect(outline);
        if (window.isEmpty()) {
          out.warnings.push({ scope: 'graphics', level: 'warn', text: `A lithophane on ${label} is outside the face.` });
          continue;
        }
        const hole = placeOnFace(slab(window, -(face.thickness + OVERLAP), OVERLAP), face);
        const clipped = relief.intersect(slab(window, -(g.litho!.max + 2), 1));
        const placed = placeOnFace(clipped, face).asOriginal();
        out.colorIds.set(placed.originalID(), g.color);
        out.solids[face.partId] = unionAll([base.subtract(hole), placed]);
        if (g.litho!.max > face.thickness + 1.5)
          out.warnings.push({ scope: 'graphics', level: 'info', text: `The lithophane on ${label} is thicker than the wall and will stand proud on the inside.` });
        continue;
      }
      let cs = layersToCS(g);
      if (!cs) continue;
      if (outline) cs = cs.intersect(outline);
      if (cs.isEmpty() || cs.area() < 0.01) {
        out.warnings.push({ scope: 'graphics', level: 'warn', text: `A graphic on ${label} lies outside the face and was skipped.` });
        continue;
      }
      const depth = Math.max(0.05, g.depth);
      if (g.mode === 'emboss') {
        const solid = placeOnFace(slab(cs, -OVERLAP, depth), face).asOriginal();
        out.colorIds.set(solid.originalID(), g.color);
        out.solids[face.partId] = base.add(solid);
        if (face.onBed) out.warnings.push({ scope: 'graphics', level: 'warn', text: `Raised graphics on ${label} face the print bed. Use Deboss or Inlay there, or print with supports.` });
        if (face.raiseLimit && depth > face.raiseLimit.max + 1e-6)
          out.warnings.push({
            scope: 'graphics',
            level: 'warn',
            text: `Raised graphics on ${label} stand ${mm(depth)} mm proud. Above ${mm(face.raiseLimit.max)} mm, ${face.raiseLimit.why}. Lower them or use Engraved.`,
          });
      } else if (g.mode === 'deboss' || g.mode === 'inlay') {
        const d = depth;
        const cutter = placeOnFace(slab(cs, -d, OVERLAP), face).asOriginal();
        out.colorIds.set(cutter.originalID(), g.color);
        out.solids[face.partId] = base.subtract(cutter);
        if (depth >= face.thickness)
          out.warnings.push({ scope: 'graphics', level: 'warn', text: `Engraving depth ${depth} mm on ${label} reaches through the ${face.thickness} mm wall.` });
        if (g.mode === 'inlay') {
          const key = `${face.partId}::${g.color.toLowerCase()}`;
          const fill = placeOnFace(slab(cs, -d, 0), face);
          const prev = out.inlays[key];
          out.inlays[key] = { partId: face.partId, color: g.color, solid: prev ? prev.solid.add(fill) : fill };
        }
      } else if (g.mode === 'cut') {
        const cutter = placeOnFace(slab(cs, -(face.thickness + OVERLAP), OVERLAP), face).asOriginal();
        out.colorIds.set(cutter.originalID(), g.color);
        out.solids[face.partId] = base.subtract(cutter);
      }
    } catch (err) {
      out.warnings.push({ scope: 'graphics', level: 'warn', text: `A graphic on ${label} could not be applied (${(err as Error).message}).` });
    }
  }
  for (const [partId, labels] of touched) tidyPart(out, partId, solids[partId], [...labels]);
  return out;
}

const mm = (v: number) => (Math.round(v * 100) / 100).toString();

/** Pieces smaller than this (mm³) are boolean leftovers, not printable features. */
export const MIN_PIECE = 0.5;

/**
 * Drop specks the booleans leave behind, and warn when graphics split a part into loose pieces
 * (the middle of an O cut through a wall falls out; a piece floating off the wall prints in mid-air).
 */
function tidyPart(out: GraphicsOutcome, partId: string, before: Manifold, labels: string[]) {
  const after = out.solids[partId];
  if (!after || after === before) return;
  const pieces = after.decompose();
  if (pieces.length <= 1) return;
  const kept = pieces.filter((m) => m.volume() >= MIN_PIECE);
  if (kept.length < pieces.length) out.solids[partId] = kept.length ? K().Manifold.compose(kept) : after;
  if (kept.length > before.decompose().length) {
    const where = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    out.warnings.push({
      scope: 'graphics',
      level: 'warn',
      text: `Graphics on ${where} leave loose pieces, like the middle of an O cut through the wall. They would fall out, or print in mid-air. Use a stencil font such as Allerta Stencil, or the Engraved effect.`,
    });
  }
}
