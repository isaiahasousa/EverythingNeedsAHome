import { BOX_ORDER, DEFAULT_PARAMS, normalizeParams } from '../boxes';
import { DEFAULT_FILAMENTS, MAX_FILAMENTS } from '../core/filaments';
import { uid } from '../core/math';
import type { BoxParams, BoxTypeId, Graphic, GraphicMode, GraphicSource } from '../core/types';
import type { SavedFont } from '../graphics/text';
import { persist, persistBeforeUnload, readIndexedDb, readLocal, savedInIndexedDb, type SaveOutcome } from './persist';

export type Units = 'mm' | 'in';

export interface Project {
  version: 1;
  name: string;
  type: BoxTypeId;
  params: BoxParams;
  graphics: Graphic[];
  units: Units;
  /** The filaments loaded in the AMS, in slot order (slot 1 first), as `#rrggbb` colours. */
  filaments: string[];
  /** The filament slot each part prints with, by part id; parts not listed use slot 1. */
  partSlots: Record<string, number>;
  printer: string;
  /** Fonts the user uploaded, kept with the project so its text looks the same after a reload. */
  fonts: SavedFont[];
}


export function newGraphic(faceId: string, source: GraphicSource, over: Partial<Graphic> = {}): Graphic {
  return {
    id: uid('g'),
    faceId,
    source,
    x: 0,
    y: 0,
    w: 40,
    h: 20,
    lockAspect: true,
    rotation: 0,
    mirror: false,
    mode: 'deboss',
    depth: 0.8,
    slot: 1,
    lithoMin: 0.8,
    lithoMax: 3,
    hidden: false,
    ...over,
  };
}

export function sampleProject(): Project {
  return {
    version: 1,
    name: 'Workshop box',
    type: 'lidded',
    params: { ...DEFAULT_PARAMS, snap: true },
    units: 'mm',
    filaments: [...DEFAULT_FILAMENTS],
    partSlots: {},
    printer: 'bed256',
    fonts: [],
    graphics: [
      newGraphic('front', { kind: 'text', text: 'WORKSHOP', font: 'archivo-black', align: 'center', lineSpacing: 1.1, letterSpacing: 0.04 }, {
        w: 62,
        h: 9.4,
        y: 2,
        mode: 'deboss',
        depth: 0.8,
      }),
      newGraphic('lid-top', { kind: 'shape', shape: 'bolt', sides: 5, ratio: 0.5, corner: 0.15 }, {
        w: 22,
        h: 36,
        mode: 'inlay',
        depth: 0.6,
        slot: 2,
      }),
      newGraphic('left', { kind: 'pattern', pattern: 'hex', cell: 4.5, web: 1.6 }, {
        w: 34,
        h: 18,
        y: 2,
        lockAspect: false,
        mode: 'cut',
      }),
    ],
  };
}

export function blankProject(type: BoxTypeId = 'tray'): Project {
  return { ...sampleProject(), name: 'Untitled box', type, graphics: [], params: { ...DEFAULT_PARAMS } };
}

const MODES: GraphicMode[] = ['emboss', 'deboss', 'cut', 'inlay', 'lithophane'];
const SOURCE_KINDS: GraphicSource['kind'][] = ['text', 'svg', 'image', 'shape', 'pattern'];

/** A `#rrggbb` colour, or the fallback: 3MF files and the preview need exactly that form. */
const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Fill in a graphic from a file and keep its numbers within what the editor allows. */
function normalizeGraphic(raw: Graphic, slots: number): Graphic {
  const g = { ...newGraphic(String(raw.faceId), raw.source), ...raw };
  const s = { ...g.source } as GraphicSource & Record<string, unknown>;
  if (s.kind === 'shape') {
    s.sides = Math.round(num(s.sides, 5, 3, 24));
    s.ratio = num(s.ratio, 0.5, 0.05, 0.95);
    s.corner = num(s.corner, 0, 0, 1);
  } else if (s.kind === 'pattern') {
    s.cell = num(s.cell, 5, 1, 40);
    s.web = num(s.web, 1.6, 0.6, 20);
  } else if (s.kind === 'text') {
    s.text = typeof s.text === 'string' ? s.text.slice(0, 2000) : '';
    s.lineSpacing = num(s.lineSpacing, 1.1, 0.5, 3);
    s.letterSpacing = num(s.letterSpacing, 0, -0.5, 2);
  } else if (s.kind === 'image') {
    s.threshold = num(s.threshold, 128, 8, 248);
    s.detail = Math.round(num(s.detail, 3, 1, 5));
  }
  return {
    ...g,
    source: s as GraphicSource,
    x: num(g.x, 0, -1000, 1000),
    y: num(g.y, 0, -1000, 1000),
    w: num(g.w, 40, 1, 1000),
    h: num(g.h, 20, 1, 1000),
    rotation: num(g.rotation, 0, -360, 360),
    depth: num(g.depth, 0.8, 0.05, 12),
    lithoMin: num(g.lithoMin, 0.8, 0.4, 5),
    lithoMax: num(g.lithoMax, 3, 0.8, 8),
    // Only photos can be lithophanes.
    mode: MODES.includes(g.mode) && (g.mode !== 'lithophane' || s.kind === 'image') ? g.mode : 'deboss',
    lockAspect: g.lockAspect !== false,
    mirror: g.mirror === true,
    hidden: g.hidden === true,
    slot: Math.round(num(g.slot, Math.min(1, slots - 1), 0, slots - 1)),
  };
}

/**
 * The palette and slots of a project file. Files from before filament slots had one body colour and a
 * colour per graphic: those become the first slots, in that order.
 */
function normalizeFilaments(p: Partial<Project> & { color?: unknown }, graphics: (Graphic & { color?: unknown })[]) {
  if (Array.isArray(p.filaments) && p.filaments.length) {
    const filaments = p.filaments.slice(0, MAX_FILAMENTS).map((c, i) => hex(c, DEFAULT_FILAMENTS[i % DEFAULT_FILAMENTS.length]));
    return { filaments, graphics };
  }
  const filaments: string[] = [hex(p.color, DEFAULT_FILAMENTS[0])];
  const slotOf = (c: unknown) => {
    const h = hex(c, '').toLowerCase();
    if (!h) return 1;
    let i = filaments.findIndex((f) => f.toLowerCase() === h);
    if (i < 0 && filaments.length < MAX_FILAMENTS) i = filaments.push(h) - 1;
    return Math.max(0, i);
  };
  // Only colour inlays print in their own colour; other graphics take their part's.
  const withSlots = graphics.map((g) => (g.mode === 'inlay' && g.slot === undefined ? { ...g, slot: slotOf(g.color) } : g));
  for (const c of DEFAULT_FILAMENTS) if (filaments.length < 4 && !filaments.some((f) => f.toLowerCase() === c)) filaments.push(c);
  return { filaments, graphics: withSlots };
}

/** Validate and fill a project parsed from JSON (file import or local storage). */
export function normalizeProject(raw: unknown): Project {
  const p = (raw ?? {}) as Partial<Project>;
  if (typeof p !== 'object' || !p.type) throw new Error('This file is not an EverythingNeedsAHome project.');
  const found = Array.isArray(p.graphics) ? p.graphics.filter((g) => g && typeof g === 'object' && g.source && typeof g.source === 'object' && SOURCE_KINDS.includes(g.source.kind)) : [];
  const { filaments, graphics } = normalizeFilaments(p, found);
  const partSlots: Record<string, number> = {};
  if (p.partSlots && typeof p.partSlots === 'object')
    for (const [id, v] of Object.entries(p.partSlots)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < filaments.length) partSlots[id] = v;
  return {
    version: 1,
    name: typeof p.name === 'string' ? p.name : 'Imported box',
    type: (BOX_ORDER as string[]).includes(p.type) ? p.type : 'tray',
    params: normalizeParams(p.params),
    graphics: graphics.map((g) => normalizeGraphic(g, filaments.length)),
    units: p.units === 'in' ? 'in' : 'mm',
    filaments,
    partSlots,
    printer: typeof p.printer === 'string' ? p.printer : 'bed256',
    fonts: Array.isArray(p.fonts)
      ? p.fonts.filter((f): f is SavedFont => !!f && typeof f.id === 'string' && f.id.startsWith('custom:') && typeof f.name === 'string' && typeof f.data === 'string')
      : [],
  };
}

/** The project's saved fonts plus `font`, dropping saved fonts no text uses any more. */
export function withFont(p: Project, font: SavedFont): SavedFont[] {
  const used = new Set(p.graphics.map((g) => (g.source.kind === 'text' ? g.source.font : '')));
  return [...p.fonts.filter((f) => f.id !== font.id && used.has(f.id)), font];
}

function tryNormalize(raw: unknown): Project | null {
  if (!raw) return null;
  try {
    return normalizeProject(raw);
  } catch {
    return null;
  }
}

/** The autosaved project when it is in localStorage (read synchronously at start-up). */
export function loadSaved(): Project | null {
  return tryNormalize(readLocal());
}

/** True when the autosave is in IndexedDB; `loadSavedAsync` then fetches it. */
export const hasLargeSave = savedInIndexedDb;

/** The autosave kept in IndexedDB; 'missing' when there is none to protect, 'error' when it could not be read. */
export async function loadSavedAsync(): Promise<Project | 'missing' | 'error'> {
  const r = await readIndexedDb();
  if (r.status !== 'ok') return r.status;
  return tryNormalize(r.value) ?? 'missing';
}

/** The project without its images, saved when nothing will take the full one. */
const withoutImages = (p: Project) => () => ({ ...p, graphics: p.graphics.filter((g) => g.source.kind !== 'image') });

export function saveLocal(p: Project): Promise<SaveOutcome> {
  return persist(p, withoutImages(p));
}

/** Save at once, as the page is hidden or closed. */
export function saveLocalNow(p: Project) {
  persistBeforeUnload(p, withoutImages(p));
}
