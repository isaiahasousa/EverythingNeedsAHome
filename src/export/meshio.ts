import { strToU8, zipSync } from 'fflate';
import type { Mat4, PartMesh } from '../core/types';

function transformPositions(pos: Float32Array, m: Mat4): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Binary STL of one or more parts, each with its own placement matrix. */
export function toSTL(items: { part: PartMesh; matrix: Mat4 }[], name = 'part'): Uint8Array {
  const triCount = items.reduce((s, it) => s + it.part.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const view = new DataView(buf);
  const header = `EverythingNeedsAHome ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, triCount, true);
  let o = 84;
  for (const { part, matrix } of items) {
    const p = transformPositions(part.positions, matrix);
    const idx = part.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
      view.setFloat32(o + 12, p[a], true); view.setFloat32(o + 16, p[a + 1], true); view.setFloat32(o + 20, p[a + 2], true);
      view.setFloat32(o + 24, p[b], true); view.setFloat32(o + 28, p[b + 1], true); view.setFloat32(o + 32, p[b + 2], true);
      view.setFloat32(o + 36, p[c], true); view.setFloat32(o + 40, p[c + 1], true); view.setFloat32(o + 44, p[c + 2], true);
      view.setUint16(o + 48, 0, true);
      o += 50;
    }
  }
  return new Uint8Array(buf);
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
const num = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? '0' : String(r);
};

function meshXML(part: PartMesh, matrix: Mat4): string {
  const p = transformPositions(part.positions, matrix);
  const chunks: string[] = ['<mesh><vertices>'];
  for (let i = 0; i < p.length; i += 3) chunks.push(`<vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>`);
  chunks.push('</vertices><triangles>');
  const idx = part.indices;
  for (let t = 0; t < idx.length; t += 3) chunks.push(`<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>`);
  chunks.push('</triangles></mesh>');
  return chunks.join('');
}

/**
 * 3MF package. Each printable part becomes one object; a part with colour inlays becomes an
 * assembly whose components slicers load as parts of a single multi-material object.
 */
export function to3MF(items: { part: PartMesh; matrix: Mat4 }[], bodyColor: string, title: string): Uint8Array {
  const colors: string[] = [bodyColor];
  const colorIndex = (c: string) => {
    const k = c.toLowerCase();
    let i = colors.findIndex((x) => x.toLowerCase() === k);
    if (i < 0) {
      colors.push(c);
      i = colors.length - 1;
    }
    return i;
  };
  let nextId = 2;
  const objects: string[] = [];
  const buildItems: string[] = [];
  for (const it of items) {
    if (it.part.role !== 'body') continue;
    const inlays = items.filter((x) => x.part.role === 'inlay' && x.part.parentId === it.part.id);
    const bodyId = nextId++;
    objects.push(`<object id="${bodyId}" type="model" name="${esc(it.part.name)}" pid="1" pindex="0">${meshXML(it.part, it.matrix)}</object>`);
    if (!inlays.length) {
      buildItems.push(`<item objectid="${bodyId}"/>`);
      continue;
    }
    const comps = [`<component objectid="${bodyId}"/>`];
    for (const inl of inlays) {
      const id = nextId++;
      const ci = colorIndex(inl.part.materials[0] ?? bodyColor);
      objects.push(`<object id="${id}" type="model" name="${esc(inl.part.name)}" pid="1" pindex="${ci}">${meshXML(inl.part, inl.matrix)}</object>`);
      comps.push(`<component objectid="${id}"/>`);
    }
    const asm = nextId++;
    objects.push(`<object id="${asm}" type="model" name="${esc(it.part.name)} (multi-colour)"><components>${comps.join('')}</components></object>`);
    buildItems.push(`<item objectid="${asm}"/>`);
  }
  const materials = colors
    .map((c, i) => `<base name="${i === 0 ? 'Body' : 'Inlay ' + esc(c)}" displaycolor="${esc(c.toUpperCase())}FF"/>`)
    .join('');
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${esc(title)}</metadata><metadata name="Application">EverythingNeedsAHome</metadata>` +
    `<resources><basematerials id="1">${materials}</basematerials>${objects.join('')}</resources>` +
    `<build>${buildItems.join('')}</build></model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
}

export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'box';
}
