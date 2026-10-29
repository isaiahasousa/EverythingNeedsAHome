// Applies placed graphics to part solids: emboss, deboss, cut-through, colour inlays and lithophanes,
// on flat faces (affine transform) and cylindrical faces (true wrap via warp).
import type { CrossSection, Manifold } from 'manifold-3d';
import { applyMatDir, frameMatrix } from '../core/math';
import type { FaceDef, Mat4, PlacedGraphic, Vec2, Vec3, Warning } from '../core/types';
import { emptySolid, K, keepPieces, poly, transformed, unionAll } from './kernel';

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
  // An empty outline extrudes to an invalid solid that would empty any boolean it touches.
  if (cs.isEmpty() || !(w1 > w0)) return emptySolid();
  return cs.extrude(w1 - w0).translate([0, 0, w0]);
}

/** Part of a graphic's outline and the height of the surface under it (0 is the wall, more is a raised graphic). */
type Region = { cs: CrossSection; h: number };

/** Stacked slabs overlap this much (mm), so slabs placed on a face one by one always fuse. */
const SEAM = 0.05;

const outlineOf = (regions: Region[]) => (regions.length === 1 ? regions[0].cs : K().CrossSection.union(regions.map((r) => r.cs)));

/**
 * Join slabs placed on a face one at a time: a single slab refines evenly and follows a curved face
 * closely, where a union refined as a whole keeps long edges whose chords sag below the surface.
 */
const placeSlabs = (face: FaceDef, slabs: [CrossSection, number, number][]) =>
  unionAll(slabs.map(([cs, w0, w1]) => placeOnFace(slab(cs, w0, w1), face)));

/** A pocket `d` deep into the surface under each region, open up to `top`. */
function pocketSolid(face: FaceDef, regions: Region[], d: number, top: number): Manifold {
  const levels = [...new Set(regions.map((r) => r.h))].sort((a, b) => b - a);
  const slabs: [CrossSection, number, number][] = [];
  let upTo = top;
  // The highest surface first: its slab spans the whole mark, and each lower one reaches deeper under
  // less of it, so each slab overlaps a wider one above.
  for (const h of levels) {
    slabs.push([outlineOf(regions.filter((r) => r.h <= h)), h - d, upTo]);
    upTo = h - d + SEAM;
  }
  return placeSlabs(face, slabs);
}

/** A raised graphic standing `depth` above the surface under each region, from just inside the wall. */
function raisedSolid(face: FaceDef, regions: Region[], depth: number): Manifold {
  const levels = [...new Set(regions.map((r) => r.h))].sort((a, b) => a - b);
  const slabs: [CrossSection, number, number][] = [];
  let from = -OVERLAP;
  // The lowest surface first: its slab spans the whole graphic, and each higher one stands taller over
  // less of it (the part under it is inside the raised graphic below).
  for (const h of levels) {
    slabs.push([outlineOf(regions.filter((r) => r.h >= h)), from, h + depth]);
    from = h + depth - SEAM;
  }
  return placeSlabs(face, slabs);
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

/** Highest point (face v) of a graphic's rotated frame. */
function frameTop(f: PlacedGraphic['frame']) {
  const a = (f.rotation * Math.PI) / 180;
  return f.y + (Math.abs(Math.sin(a)) * f.w + Math.abs(Math.cos(a)) * f.h) / 2;
}

/**
 * Apply graphics to the part solids. `prints` (part id -> print rotation) lets raised graphics be checked
 * against the direction they will print in.
 */
export function applyGraphics(
  solids: Record<string, Manifold>,
  faces: FaceDef[],
  graphics: PlacedGraphic[],
  prints: Record<string, Mat4> = {},
): GraphicsOutcome {
  // Evaluate each part once up front (a build has already done so). Otherwise the part and its envelope
  // below would each evaluate their own mesh of it, and two meshes of one shape disagree where faces meet.
  for (const m of Object.values(solids)) m.status();
  const out: GraphicsOutcome = { solids: { ...solids }, inlays: {}, colorIds: new Map(), warnings: [] };
  const faceById = new Map(faces.map((f) => [f.id, f]));
  /** Face labels with graphics, per part, for the loose-piece warning. */
  const touched = new Map<string, Set<string>>();
  /** Raised graphics so far on each face (outline and height): later marks go through and sit on them. */
  const raisedOn = new Map<string, Region[]>();
  /** The parts of an outline over each surface height on a face: the wall (0) or a raised graphic on it. */
  const regionsOn = (faceId: string, cs: CrossSection) => {
    let rest = cs;
    const regions: Region[] = [];
    for (const r of [...(raisedOn.get(faceId) ?? [])].sort((a, b) => b.h - a.h)) {
      const on = rest.intersect(r.cs);
      if (on.isEmpty()) continue;
      regions.push({ cs: on, h: r.h });
      rest = rest.subtract(r.cs);
    }
    if (!rest.isEmpty()) regions.push({ cs: rest, h: 0 });
    return regions;
  };
  /** A cut-through or lithophane takes out the raised graphics in its outline. */
  const clearRaised = (faceId: string, cs: CrossSection) => {
    const list = raisedOn.get(faceId);
    if (list) raisedOn.set(faceId, list.map((r) => ({ cs: r.cs.subtract(cs), h: r.h })).filter((r) => !r.cs.isEmpty()));
  };
  /**
   * The tallest of `heights` at which raised graphics on a face drop more than `limit` mm to the surface
   * beside them (0 when none do): anything raised that tall, with lower ground just past its edge.
   */
  const tallStep = (faceId: string, heights: number[], limit: number) => {
    const list = raisedOn.get(faceId) ?? [];
    for (const h of [...new Set(heights)].sort((a, b) => b - a)) {
      if (h <= limit + 1e-6) break;
      const high = list.filter((r) => r.h >= h - 1e-6);
      if (!high.length) continue;
      const near = list.filter((r) => r.h >= h - limit - 1e-6);
      // A thin band just outside the edges, minus what stands within `limit` of the top.
      if (outlineOf(high).offset(0.05, 'Miter').subtract(outlineOf(near)).area() > 0.025) return h;
    }
    return 0;
  };
  /**
   * Each part as designed, with the raised graphics, cut-throughs and lithophanes so far but not the
   * pockets: an inlay's colour fills all the material its pocket takes out, so it paints over earlier marks.
   * Until a part has a pocket it is the part itself, mesh for mesh.
   */
  const envelope = new Map<string, Manifold>();
  const envelopeOf = (partId: string) => envelope.get(partId) ?? solids[partId];
  /** Record a step that changes the envelope too: `base` was the part before it, `step` makes the new one. */
  const grow = (partId: string, base: Manifold, step: (m: Manifold) => Manifold) => {
    const env = envelopeOf(partId);
    envelope.set(partId, env === base ? out.solids[partId] : step(env));
  };
  /** Each part's convex hull: lithophanes never reach outside the part. */
  const hulls = new Map<string, Manifold>();
  const hullOf = (partId: string) => {
    if (!hulls.has(partId)) hulls.set(partId, solids[partId].hull());
    return hulls.get(partId)!;
  };
  /**
   * A later graphic paints over earlier ones: what it adds to the part or takes out of it is no longer an
   * earlier inlay's colour. (Clearing each step's own solid keeps colour and body apart without subtracting
   * the finished body, whose faces the colour shares; that boolean can leave slivers outside the part.)
   */
  const clearFills = (partId: string, solid: Manifold) => {
    for (const inl of Object.values(out.inlays)) if (inl.partId === partId) inl.solid = inl.solid.subtract(solid);
  };
  /**
   * Keep a step's result only if it is a valid, non-empty solid that lost no more than the cutter could
   * remove. Anything else (a degenerate outline, a numerical failure) leaves the part as it was.
   */
  const commit = (partId: string, before: Manifold, next: Manifold, maxLoss: number, label: string) => {
    const ok = next.status() === 'NoError' && !next.isEmpty() && before.volume() - next.volume() <= maxLoss + 1;
    if (ok) out.solids[partId] = next;
    else out.warnings.push({ scope: 'graphics', level: 'warn', text: `A graphic on ${label} could not be applied with these settings, so it was left out.` });
    return ok;
  };
  /** Whether a face prints sideways (not facing up, not on the bed): flat undersides there are overhangs. */
  const sideways = (face: FaceDef) => {
    const n: Vec3 = face.kind === 'plane' ? face.n : [0, -1, 0];
    const up = prints[face.partId] ? applyMatDir(prints[face.partId], n)[2] : n[2];
    return !face.onBed && up < 0.7;
  };
  let orphans = 0;
  for (const g of graphics) {
    const face = faceById.get(g.faceId);
    if (!face) {
      orphans++;
      continue;
    }
    const base = out.solids[face.partId];
    if (!base) continue;
    const label = `“${face.label}”`;
    if (!touched.has(face.partId)) touched.set(face.partId, new Set());
    touched.get(face.partId)!.add(label);
    // Cutters start above any raised graphic already on this face, so they go through it.
    const top = OVERLAP + Math.max(0, ...(raisedOn.get(face.id) ?? []).map((r) => r.h));
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
        // The relief may reach inward only as far as the wall, plus any free space behind it: past that
        // it would hit a lid lip, a mating part or a drawer. The brightness range is squeezed to fit.
        const behind = face.roomTop === undefined || frameTop(g.frame) <= face.roomTop ? (face.innerRoom ?? 0) : 0;
        const room = face.thickness + behind;
        const L = g.litho!;
        let fitted = g;
        if (L.max > room + 1e-6) {
          const max = room;
          fitted = { ...g, litho: { ...L, max, min: Math.max(0.2, Math.min(L.min, max - 0.2)) } };
          out.warnings.push({
            scope: 'graphics',
            level: 'info',
            text: `The lithophane on ${label} is limited to ${mm(max)} mm thick so it does not get in the way of the parts behind it. Thicker walls give it more contrast.`,
          });
        }
        const relief = lithophane(fitted);
        if (!relief) continue;
        const window = rectCS(g.frame.w, g.frame.h, g.frame.x, g.frame.y, g.frame.rotation).intersect(outline);
        // Through the wall the hole is a hair smaller than the relief, so the two overlap and always fuse
        // into one part; above the wall it takes the whole window, raised graphics and all.
        const holeWindow = window.offset(-0.02, 'Miter');
        if (window.area() < 0.05 || holeWindow.isEmpty()) {
          out.warnings.push({ scope: 'graphics', level: 'warn', text: `A lithophane on ${label} is outside the face.` });
          continue;
        }
        const hole = placeSlabs(face, [
          [holeWindow, -(face.thickness + OVERLAP), 0],
          [window, -SEAM, top],
        ]);
        const clipped = relief.intersect(slab(window, -(fitted.litho!.max + 2), 1));
        // Never outside the part (on a triangular box the relief would poke through the next side).
        const placed = placeOnFace(clipped, face).intersect(hullOf(face.partId)).asOriginal();
        out.colorIds.set(placed.originalID(), g.color);
        if (!commit(face.partId, base, unionAll([base.subtract(hole), placed]), hole.volume(), label)) continue;
        grow(face.partId, base, (m) => unionAll([m.subtract(hole), placed]));
        clearFills(face.partId, hole);
        clearFills(face.partId, placed);
        clearRaised(face.id, window);
        const inward = fitted.litho!.max - face.thickness;
        if (inward > 2 + 1e-6 && sideways(face))
          out.warnings.push({
            scope: 'graphics',
            level: 'warn',
            text: `The lithophane on ${label} reaches ${mm(inward)} mm past the inside of the wall. Printed on its side, that ledge needs supports. Set its thickest part to at most ${mm(face.thickness + 2)} mm, or use thicker walls.`,
          });
        else if (inward > 1.5)
          out.warnings.push({ scope: 'graphics', level: 'info', text: `The lithophane on ${label} is thicker than the wall and will stand proud on the inside.` });
        continue;
      }
      let cs = layersToCS(g);
      if (!cs) continue;
      cs = cs.intersect(outline);
      if (cs.isEmpty() || cs.area() < 0.01) {
        out.warnings.push({ scope: 'graphics', level: 'warn', text: `A graphic on ${label} lies outside the face and was skipped.` });
        continue;
      }
      const depth = Math.max(0.05, g.depth);
      // Heights and depths count from the surface under the graphic, so one on a raised plaque sits on it.
      const regions = regionsOn(face.id, cs);
      if (g.mode === 'emboss') {
        const solid = raisedSolid(face, regions, depth).asOriginal();
        out.colorIds.set(solid.originalID(), g.color);
        if (!commit(face.partId, base, base.add(solid), 0, label)) continue;
        grow(face.partId, base, (m) => m.add(solid));
        clearFills(face.partId, solid);
        raisedOn.set(face.id, [...(raisedOn.get(face.id) ?? []), ...regions.map((r) => ({ cs: r.cs, h: r.h + depth }))]);
        const proud = Math.max(...regions.map((r) => r.h)) + depth;
        if (face.onBed) out.warnings.push({ scope: 'graphics', level: 'warn', text: `Raised graphics on ${label} face the print bed. Use Deboss or Inlay there, or print with supports.` });
        // On a face that prints sideways, a raised edge is a flat overhang as deep as the step down beside it:
        // stacked graphics whose edges line up make one tall step.
        const step = sideways(face) ? tallStep(face.id, regions.map((r) => r.h + depth), 2) : 0;
        if (step)
          out.warnings.push({
            scope: 'graphics',
            level: 'warn',
            text: `Raised graphics on ${label} stand ${mm(step)} mm proud at an edge. Printed on its side, an edge over 2 mm tall leaves an overhang underneath that needs supports. Lower them, keep the edges of stacked graphics apart, or use Engraved.`,
          });
        if (face.raiseLimit && proud > face.raiseLimit.max + 1e-6)
          out.warnings.push({
            scope: 'graphics',
            level: 'warn',
            text: `Raised graphics on ${label} stand ${mm(proud)} mm proud. Above ${mm(face.raiseLimit.max)} mm, ${face.raiseLimit.why}. Lower them or use Engraved.`,
          });
      } else if (g.mode === 'deboss' || g.mode === 'inlay') {
        const cutter = pocketSolid(face, regions, depth, top).asOriginal();
        out.colorIds.set(cutter.originalID(), g.color);
        if (!commit(face.partId, base, base.subtract(cutter), cutter.volume(), label)) continue;
        if (regions.some((r) => r.cs.area() >= 0.01 && depth - r.h >= face.thickness))
          out.warnings.push({
            scope: 'graphics',
            level: 'warn',
            text: g.mode === 'inlay' ? `Inlay depth ${depth} mm on ${label} goes through the ${face.thickness} mm wall, so the colour shows inside too.` : `Engraving depth ${depth} mm on ${label} reaches through the ${face.thickness} mm wall.`,
          });
        // A later graphic paints over earlier ones: its pocket takes the colour out of earlier inlays.
        clearFills(face.partId, cutter);
        if (g.mode === 'inlay') {
          const key = `${face.partId}::${g.color.toLowerCase()}`;
          // The colour is the material the pocket took out, earlier marks included: flush with the surface
          // around it, and flush inside a wall it goes through.
          const fill = cutter.intersect(envelopeOf(face.partId));
          const prev = out.inlays[key];
          out.inlays[key] = { partId: face.partId, color: g.color, solid: prev ? prev.solid.add(fill) : fill };
        }
      } else if (g.mode === 'cut') {
        const cutter = placeOnFace(slab(cs, -(face.thickness + OVERLAP), top), face).asOriginal();
        out.colorIds.set(cutter.originalID(), g.color);
        if (!commit(face.partId, base, base.subtract(cutter), cutter.volume(), label)) continue;
        grow(face.partId, base, (m) => m.subtract(cutter));
        clearFills(face.partId, cutter);
        clearRaised(face.id, cs);
      }
    } catch (err) {
      out.warnings.push({ scope: 'graphics', level: 'warn', text: `A graphic on ${label} could not be applied (${(err as Error).message}).` });
    }
  }
  for (const [partId, labels] of touched) tidyPart(out, partId, solids[partId], [...labels]);
  for (const inl of Object.values(out.inlays)) {
    const body = out.solids[inl.partId];
    let fill = inl.solid;
    // Where colour and body share faces a boolean can come out slightly wrong and leave colour inside the
    // body. A union tells when there is real overlap; only then take the body out, since doing it every
    // time can itself leave slivers outside the part.
    if (fill.volume() + body.volume() - fill.add(body).volume() > 0.01) fill = fill.subtract(body);
    inl.solid = dropSlivers(fill);
  }
  if (orphans)
    out.warnings.push({
      scope: 'graphics',
      level: 'warn',
      text: `${orphans === 1 ? 'A graphic is' : `${orphans} graphics are`} on a face this box does not have with these settings, so ${orphans === 1 ? 'it is' : 'they are'} left out. Move ${orphans === 1 ? 'it' : 'them'} to another face in the Graphics step.`,
    });
  return out;
}

/** Remove boolean slivers from an inlay fill: tiny, or thinner on average than 0.1 mm. Real pieces stay. */
function dropSlivers(m: Manifold): Manifold {
  return keepPieces(m, m.decompose(), (v, q) => (v < 0 ? v <= -0.02 : v >= 0.02 && (2 * v) / Math.max(1e-9, q.surfaceArea()) >= 0.05));
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
  const solidCount = pieces.filter((m) => m.volume() >= MIN_PIECE).length;
  if (solidCount === 0) {
    out.solids[partId] = before;
    for (const [key, inl] of Object.entries(out.inlays)) if (inl.partId === partId) delete out.inlays[key];
    out.warnings.push({ scope: 'graphics', level: 'warn', text: `Graphics on ${labels.join(', ')} could not be applied with these settings, so they were left out.` });
    return;
  }
  // Drop specks; real pieces and sealed voids (inward-facing shells with negative volume) stay.
  out.solids[partId] = keepPieces(after, pieces, (v) => Math.abs(v) >= MIN_PIECE);
  if (solidCount > before.decompose().filter((m) => m.volume() > 0).length) {
    const where = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    out.warnings.push({
      scope: 'graphics',
      level: 'warn',
      text: `Graphics on ${where} leave loose pieces, like the middle of an O cut through the wall. They would fall out, or print in mid-air. Use a stencil font such as Allerta Stencil, or the Engraved effect.`,
    });
  }
}
