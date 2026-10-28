import { useMemo } from 'react';
import { BOX_TYPES } from '../boxes';
import type { FaceDef, Graphic, PlacedGraphic, Resolved, Warning } from '../core/types';
import { lithophanePixels } from '../graphics/raster';
import { onOutlineEpoch, resolveShape } from '../graphics/resolve';
import { placeGraphic } from '../graphics/shape2d';
import { builtinShape } from '../graphics/shapes';
import { BuildClient } from '../worker/client';
import type { Project } from './project';
import { buildStore, projectStore, useProject } from './store';

let client: BuildClient | null = null;
let seq = 0;
/** True from a change until the build that includes it starts, so older results are never marked ready. */
let dirty = false;
let fatal = false;
let prev: { type?: string; params?: unknown; graphics?: unknown } = {};
let timer: ReturnType<typeof setTimeout> | undefined;
const shapeVersion = { n: 0 };

const unitRect = builtinShape('rect', 4, 0.5, 0);

async function placeAll(p: Project): Promise<{ graphics: PlacedGraphic[]; notes: Warning[] }> {
  const out: PlacedGraphic[] = [];
  const notes: Warning[] = [];
  const faceLabel = (id: string) => {
    const t = BOX_TYPES[p.type];
    return t.faces(p.params, t.resolve(p.params)).find((f) => f.id === id)?.label ?? id;
  };
  for (const g of p.graphics) {
    if (g.hidden) continue;
    try {
      if (g.mode === 'lithophane') {
        if (g.source.kind !== 'image') continue;
        const pg = placeGraphic(g, unitRect);
        const px = await lithophanePixels(g.source.dataUrl, g.w, g.h, true);
        pg.litho = { ...px, min: Math.min(g.lithoMin, g.lithoMax), max: Math.max(g.lithoMin, g.lithoMax) };
        out.push(pg);
      } else {
        out.push(placeGraphic(g, await resolveShape(g)));
      }
    } catch (e) {
      // Build the rest, and say what was left out (the graphics panel also shows the error inline).
      notes.push({ scope: 'graphics', level: 'warn', text: `A graphic on “${faceLabel(g.faceId)}” was left out: ${String((e as Error)?.message ?? e)}` });
    }
  }
  return { graphics: out, notes };
}

const markBuilding = () => buildStore.set((s) => (s.status === 'building' || s.status === 'loading' ? s : { ...s, status: 'building' }));

async function run() {
  const p = projectStore.get();
  const id = ++seq;
  dirty = false;
  markBuilding();
  const { graphics, notes } = await placeAll(p);
  if (id !== seq || !client) return;
  client.request({ id, type: p.type, params: p.params, graphics, notes, quality: 'fine' });
}

/** True when `id` is the newest build and nothing has changed since it started. */
const isCurrent = (id: number) => id === seq && !dirty;

function schedule(delay = 40) {
  if (fatal) return;
  // Downloads switch off right away: the last result no longer matches the settings.
  dirty = true;
  markBuilding();
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

export function startBuilds() {
  if (client) return;
  client = new BuildClient();
  client.onReady = (engine) => {
    buildStore.set((s) => ({ ...s, engine }));
    if (fatal) return;
    clearTimeout(timer);
    timer = setTimeout(run, 0);
  };
  client.onResult = (result) => {
    // An older result still updates the preview, but only the newest one can be downloaded.
    const current = isCurrent(result.id);
    buildStore.set((s) => ({ ...s, status: current ? 'ready' : s.status === 'loading' ? 'building' : s.status, result, error: current ? null : s.error }));
  };
  client.onError = (id, message) => {
    if (!isCurrent(id)) return; // a newer build is on its way
    buildStore.set((s) => ({ ...s, status: 'error', error: message }));
  };
  client.onFatal = (message) => {
    fatal = true;
    clearTimeout(timer);
    buildStore.set({
      status: 'error',
      result: null,
      error: `The geometry engine could not start (${message}). Reload the page; if it keeps failing, try a current Chrome, Edge, Firefox or Safari.`,
    });
  };
  projectStore.subscribe(() => {
    const p = projectStore.get();
    if (p.type === prev.type && p.params === prev.params && p.graphics === prev.graphics) return;
    prev = { type: p.type, params: p.params, graphics: p.graphics };
    schedule();
  });
  const p = projectStore.get();
  prev = { type: p.type, params: p.params, graphics: p.graphics };
  // A user font finished loading: text that was waiting for it (or failed without it) changes.
  onOutlineEpoch(() => rebuild());
}

/** Re-run the build after an outline finished resolving elsewhere (e.g. a font loaded). */
export function rebuild() {
  shapeVersion.n++;
  schedule(0);
}

export interface FaceInfo {
  faces: FaceDef[];
  resolved: Resolved;
  warnings: Warning[];
}

export function useFaces(): FaceInfo {
  const type = useProject((p) => p.type);
  const params = useProject((p) => p.params);
  return useMemo(() => {
    const t = BOX_TYPES[type];
    const resolved = t.resolve(params);
    return { faces: t.faces(params, resolved), resolved, warnings: t.warnings(params, resolved) };
  }, [type, params]);
}

export function graphicsOnFace(graphics: Graphic[], faceId: string) {
  return graphics.filter((g) => g.faceId === faceId);
}
