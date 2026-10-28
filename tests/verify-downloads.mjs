// Re-imports exported files (3MF, STL, ZIP of STLs, project JSON) and checks that every mesh is a
// watertight solid resting on the bed. Usage: node tests/verify-downloads.mjs <directory>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import Module from 'manifold-3d';

function parseSTL(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 !== buf.byteLength) throw new Error('STL length does not match its triangle count');
  const verts = [];
  const tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 3; k++) {
      verts.push(dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true));
      tris.push(i * 3 + k);
    }
  }
  return { verts, tris };
}

/** Returns a list of problems (empty when every file is valid). */
export async function verifyDownloads(dir, log = console.log) {
  const wasm = await Module();
  wasm.setup();
  const { Manifold, Mesh } = wasm;
  const problems = [];
  const check = (label, verts, tris) => {
    const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
    mesh.merge();
    const m = Manifold.ofMesh(mesh);
    const bb = m.boundingBox();
    log(`  ${label.padEnd(38)} ${String(tris.length / 3).padStart(7)} tris  ${m.status().padEnd(8)} ${(m.volume() / 1000).toFixed(2)} cm3  z ${bb.min[2].toFixed(2)}..${bb.max[2].toFixed(2)}`);
    if (m.status() !== 'NoError') problems.push(`${label}: not a closed solid (${m.status()})`);
    else if (m.volume() <= 0) problems.push(`${label}: zero or inverted volume`);
    else if (Math.abs(bb.min[2]) > 0.01) problems.push(`${label}: does not sit on the bed (min z ${bb.min[2].toFixed(3)})`);
    m.delete();
  };
  const files = fs.readdirSync(dir).filter((f) => /\.(3mf|stl|zip|json)$/i.test(f));
  if (!files.length) problems.push(`no exported files found in ${dir}`);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    log(f);
    try {
      if (/\.3mf$/i.test(f)) {
        const zip = unzipSync(new Uint8Array(buf));
        for (const need of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model'])
          if (!zip[need]) problems.push(`${f}: missing ${need}`);
        const xml = strFromU8(zip['3D/3dmodel.model']);
        const objects = [...xml.matchAll(/<object id="(\d+)"[^>]*name="([^"]*)"[^>]*>(.*?)<\/object>/gs)];
        for (const [, id, name, body] of objects) {
          if (!body.includes('<mesh>')) {
            log(`  assembly ${id} "${name}": components ${[...body.matchAll(/component objectid="(\d+)"/g)].map((m) => m[1]).join(', ')}`);
            continue;
          }
          const verts = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
          const tris = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
          check(`3mf object ${id} ${name}`, verts, tris);
        }
        if (!/<item objectid="\d+"/.test(xml)) problems.push(`${f}: build has no items`);
      } else if (/\.zip$/i.test(f)) {
        const zip = unzipSync(new Uint8Array(buf));
        for (const [name, data] of Object.entries(zip)) {
          if (/\.stl$/i.test(name)) {
            const { verts, tris } = parseSTL(data);
            check(name, verts, tris);
          } else if (/\.3mf$/i.test(name)) log(`  (nested 3MF ${name})`);
        }
      } else if (/\.stl$/i.test(f)) {
        const { verts, tris } = parseSTL(new Uint8Array(buf));
        check(f, verts, tris);
      } else {
        const p = JSON.parse(buf.toString());
        if (!p.type || !Array.isArray(p.graphics)) problems.push(`${f}: not a project file`);
        log(`  project "${p.name}", ${p.type}, ${p.graphics.length} graphics`);
      }
    } catch (err) {
      problems.push(`${f}: ${err.message}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node tests/verify-downloads.mjs <directory>');
    process.exit(2);
  }
  const problems = await verifyDownloads(dir);
  if (problems.length) {
    console.error('\nFAILED:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('\nAll exported files are valid.');
}
