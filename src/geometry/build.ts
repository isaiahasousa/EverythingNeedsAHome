// Orchestrates one build: box solids -> graphics -> render/export meshes. Runs in the worker.
import type { Manifold } from 'manifold-3d';
import { BOX_TYPES } from '../boxes';
import type { BuildRequest, BuildResult, Mat4, MeshGroup, PartInfo, PartMesh, Vec3, Warning } from '../core/types';
import { applyGraphics, MIN_PIECE } from './graphics3d';
import { keepPieces, releaseAll, setQuality, transformed } from './kernel';

const CREASE = Math.cos((32 * Math.PI) / 180);
const EDGE = Math.cos((38 * Math.PI) / 180);

/**
 * Display data: per-corner normals averaged only across faces within the crease angle (smooth
 * cylinders, crisp box edges), and the feature edges for the outline overlay.
 */
export function renderData(pos: Float32Array, idx: Uint32Array) {
  const nt = idx.length / 3;
  const nv = pos.length / 3;
  const fn = new Float32Array(nt * 3); // area-weighted face normals
  const unit = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
    const l = Math.hypot(x, y, z) || 1;
    unit[t * 3] = x / l; unit[t * 3 + 1] = y / l; unit[t * 3 + 2] = z / l;
  }
  // vertex -> incident triangles (CSR)
  const deg = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) deg[idx[i] + 1]++;
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const fill = deg.slice(0, nv);
  const inc = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) inc[fill[idx[i]]++] = (i / 3) | 0;
  const rp = new Float32Array(nt * 9);
  const rn = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const ux = unit[t * 3], uy = unit[t * 3 + 1], uz = unit[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      let x = 0, y = 0, z = 0;
      for (let j = deg[v]; j < deg[v + 1]; j++) {
        const f = inc[j];
        if (unit[f * 3] * ux + unit[f * 3 + 1] * uy + unit[f * 3 + 2] * uz >= CREASE) {
          x += fn[f * 3]; y += fn[f * 3 + 1]; z += fn[f * 3 + 2];
        }
      }
      const l = Math.hypot(x, y, z) || 1;
      const o = t * 9 + k * 3;
      rn[o] = x / l; rn[o + 1] = y / l; rn[o + 2] = z / l;
      rp[o] = pos[v * 3]; rp[o + 1] = pos[v * 3 + 1]; rp[o + 2] = pos[v * 3 + 2];
    }
  }
  // feature edges: each undirected edge seen twice in a closed mesh
  const seen = new Map<number, number>();
  const lines: number[] = [];
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * nv + hi;
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, t);
        continue;
      }
      seen.delete(key);
      const d = unit[t * 3] * unit[other * 3] + unit[t * 3 + 1] * unit[other * 3 + 1] + unit[t * 3 + 2] * unit[other * 3 + 2];
      if (d < EDGE) lines.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
    }
  return { renderPositions: rp, renderNormals: rn, edges: new Float32Array(lines) };
}

function toPartMesh(
  m: Manifold,
  info: { id: string; name: string; role: 'body' | 'inlay'; parentId?: string; print: Mat4; explode: Vec3; open?: PartInfo['open']; tip?: string },
  colorIds: Map<number, string>,
  bodyColor: string | null,
): PartMesh {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  let positions: Float32Array;
  if (np === 3) positions = new Float32Array(mesh.vertProperties);
  else {
    positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) positions.set(mesh.vertProperties.subarray(i * np, i * np + 3), i * 3);
  }
  const tri = mesh.triVerts;
  const materials: (string | null)[] = [bodyColor];
  const matIndex = new Map<string, number>();
  const runMat: number[] = [];
  const runCount = mesh.runOriginalID?.length ?? 0;
  for (let r = 0; r < runCount; r++) {
    const color = colorIds.get(mesh.runOriginalID[r]);
    if (!color) {
      runMat.push(0);
      continue;
    }
    let idx = matIndex.get(color);
    if (idx === undefined) {
      idx = materials.length;
      materials.push(color);
      matIndex.set(color, idx);
    }
    runMat.push(idx);
  }
  const counts = new Array(materials.length).fill(0);
  if (runCount === 0) counts[0] = tri.length;
  for (let r = 0; r < runCount; r++) counts[runMat[r]] += mesh.runIndex[r + 1] - mesh.runIndex[r];
  const offsets: number[] = [];
  const groups: MeshGroup[] = [];
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    offsets.push(acc);
    if (counts[i] > 0) groups.push({ start: acc, count: counts[i], materialIndex: i });
    acc += counts[i];
  }
  const indices = new Uint32Array(tri.length);
  if (runCount === 0) indices.set(tri);
  else
    for (let r = 0; r < runCount; r++) {
      const s = mesh.runIndex[r], e = mesh.runIndex[r + 1];
      indices.set(tri.subarray(s, e), offsets[runMat[r]]);
      offsets[runMat[r]] += e - s;
    }
  const bb = transformed(m, info.print).boundingBox();
  return {
    id: info.id,
    name: info.name,
    role: info.role,
    parentId: info.parentId,
    positions,
    indices,
    ...renderData(positions, indices),
    groups,
    materials,
    print: info.print,
    explode: info.explode,
    open: info.open,
    tip: info.tip,
    volume: m.volume(),
    triangles: tri.length / 3,
    printMin: [bb.min[0], bb.min[1], bb.min[2]],
    printMax: [bb.max[0], bb.max[1], bb.max[2]],
  };
}

export function runBuild(req: BuildRequest): BuildResult {
  const t0 = performance.now();
  setQuality(req.quality);
  const type = BOX_TYPES[req.type];
  const R = type.resolve(req.params);
  const faces = type.faces(req.params, R);
  const infos = type.parts(req.params, R);
  const warnings: Warning[] = type.warnings(req.params, R);
  const parts: PartMesh[] = [];
  try {
    if (warnings.some((w) => w.level === 'error')) return { id: req.id, parts, faces, warnings, ms: performance.now() - t0 };
    const solids = type.build(req.params, R);
    // Settings the checks above missed must never silently drop or split a part.
    for (const info of infos) {
      const solid = solids[info.id];
      if (!solid || solid.isEmpty() || solid.status() !== 'NoError') {
        warnings.push({ level: 'error', text: `The ${info.name.toLowerCase()} has no solid left with these settings. Make the box larger or the walls and lips thinner.` });
        continue;
      }
      // Specks left by the booleans are not printable; drop them (keeping any sealed voids) before counting pieces.
      const pieces = solid.decompose();
      if (pieces.length < 2) continue;
      const real = pieces.filter((m) => m.volume() >= MIN_PIECE).length;
      if (real) solids[info.id] = keepPieces(solid, pieces, (v) => Math.abs(v) >= MIN_PIECE);
      if (real > 1)
        warnings.push({ level: 'warn', text: `The ${info.name.toLowerCase()} comes out in ${real} separate pieces with these settings. Try thicker walls or a larger box.` });
    }
    if (warnings.some((w) => w.level === 'error')) return { id: req.id, parts, faces, warnings, ms: performance.now() - t0 };
    const g = applyGraphics(solids, faces, req.graphics, Object.fromEntries(infos.map((i) => [i.id, i.print])));
    warnings.push(...g.warnings, ...(req.notes ?? []));
    for (const info of infos) {
      const solid = g.solids[info.id];
      // Last guard: a part the graphics broke is never exported.
      if (!solid || solid.isEmpty() || solid.status() !== 'NoError') {
        warnings.push({ level: 'error', text: `The ${info.name.toLowerCase()} could not be built with these graphics. Undo the last change or move the graphic.` });
        continue;
      }
      parts.push(toPartMesh(solid, { ...info, role: 'body' }, g.colorIds, null));
    }
    for (const [key, inlay] of Object.entries(g.inlays)) {
      const parent = infos.find((i) => i.id === inlay.partId);
      if (!parent || inlay.solid.isEmpty()) continue;
      parts.push(
        toPartMesh(
          inlay.solid,
          { id: `inlay-${key.replace(/[^a-z0-9]/gi, '')}`, name: `${parent.name} inlay ${inlay.color}`, role: 'inlay', parentId: parent.id, print: parent.print, explode: parent.explode, open: parent.open },
          new Map(),
          inlay.color,
        ),
      );
    }
  } finally {
    releaseAll();
  }
  return { id: req.id, parts, faces, warnings, ms: performance.now() - t0 };
}
