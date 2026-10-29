import { useSyncExternalStore } from 'react';
import type { BuildResult, Graphic } from '../core/types';
import { registerSavedFonts } from '../graphics/text';
import { pauseAutosave } from './persist';
import { hasLargeSave, loadSaved, loadSavedAsync, sampleProject, saveLocal, type Project } from './project';

export type Step = 'type' | 'size' | 'details' | 'graphics' | 'export';
export type ViewMode = 'assembled' | 'exploded' | 'print';

export interface UIState {
  step: Step;
  view: ViewMode;
  faceId: string | null;
  selected: string | null;
  /** On narrow screens the graphics step toggles between the 3D view and the face editor. */
  mobilePane: '3d' | 'face';
  toast: { text: string; tone: 'ok' | 'warn' | 'error'; at: number } | null;
}

export interface BuildState {
  /** 'js' when WebAssembly is blocked and the slower JavaScript engine is running. */
  engine?: 'wasm' | 'js';
  status: 'loading' | 'building' | 'ready' | 'error';
  result: BuildResult | null;
  error: string | null;
}

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((s: T) => T)) {
      const value = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const projectStore = createStore<Project>(loadSaved() ?? sampleProject());
// Uploaded fonts travel inside the project: make them available before anything draws its text.
registerSavedFonts(projectStore.get().fonts);
projectStore.subscribe(() => registerSavedFonts(projectStore.get().fonts));

/**
 * A project with large images is autosaved in IndexedDB, which can only be read asynchronously. The app
 * renders after this settles, so nothing can edit the placeholder project first and overwrite the save.
 */
export async function loadLargeSave(): Promise<void> {
  if (!hasLargeSave()) return;
  const timeout = new Promise<'error'>((resolve) => setTimeout(() => resolve('error'), 6000));
  const p = await Promise.race([loadSavedAsync(), timeout]);
  if (p === 'missing') {
    // Nothing left to protect (site data was cleared): start fresh, and autosave replaces the pointer.
    toast('Your last autosaved project is no longer in this browser’s storage, so the app started fresh.', 'warn');
  } else if (p === 'error') {
    // Leave the saved copy alone until a reload can read it.
    pauseAutosave();
    toast('Your last project could not be read from this browser’s storage, so autosave is paused to keep it safe. Reload to try again.', 'warn');
  } else projectStore.set(p);
}
export const uiStore = createStore<UIState>({
  step: 'type',
  view: 'assembled',
  faceId: null,
  selected: null,
  mobilePane: '3d',
  toast: null,
});
export const buildStore = createStore<BuildState>({ status: 'loading', result: null, error: null });

export function useProject<S>(sel: (p: Project) => S): S {
  return useSyncExternalStore(projectStore.subscribe, () => sel(projectStore.get()));
}
export function useUI<S>(sel: (u: UIState) => S): S {
  return useSyncExternalStore(uiStore.subscribe, () => sel(uiStore.get()));
}
export function useBuild<S>(sel: (b: BuildState) => S): S {
  return useSyncExternalStore(buildStore.subscribe, () => sel(buildStore.get()));
}

// ------------------------------------------------------------------ history

const past: Project[] = [];
const future: Project[] = [];
let lastKey = '';
let lastTime = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const historyStore = createStore({ canUndo: false, canRedo: false });
const syncHistory = () => historyStore.set({ canUndo: past.length > 0, canRedo: future.length > 0 });

/**
 * Apply a change to the project. Rapid edits with the same `key` (dragging a slider, typing) merge
 * into one undo step.
 */
export function update(fn: (p: Project) => Project, key = '') {
  const prev = projectStore.get();
  const next = fn(prev);
  if (next === prev) return;
  const now = performance.now();
  if (!(key && key === lastKey && now - lastTime < 900)) {
    past.push(prev);
    if (past.length > 120) past.shift();
  }
  lastKey = key;
  lastTime = now;
  future.length = 0;
  projectStore.set(next);
  syncHistory();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    autosave(projectStore.get());
  }, 400);
}

/** Save at once if an autosave is still waiting (the page is being hidden, reloaded or closed). */
export function flushAutosave() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  autosave(projectStore.get());
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAutosave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAutosave();
  });
}

let autosaveNoticeShown = false;

function autosave(p: Project) {
  void saveLocal(p).then((outcome) => {
    if (autosaveNoticeShown || outcome === 'local' || outcome === 'indexeddb' || outcome === 'paused') return;
    autosaveNoticeShown = true;
    toast(
      outcome === 'dropped-images'
        ? 'Your images are too big for this browser’s autosave, so they would be lost on reload. Use Save project on the Print step to keep them.'
        : 'This browser is not letting the app autosave. Use Save project on the Print step to keep your work.',
      'warn',
    );
  });
}

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(projectStore.get());
  lastKey = '';
  projectStore.set(prev);
  syncHistory();
  autosave(prev);
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(projectStore.get());
  lastKey = '';
  projectStore.set(next);
  syncHistory();
  autosave(next);
}

export function replaceProject(p: Project) {
  update(() => p);
  uiStore.set((u) => ({ ...u, selected: null, faceId: null }));
}

// ------------------------------------------------------------------ helpers

export function setParam<K extends keyof Project['params']>(key: K, value: Project['params'][K]) {
  update((p) => (p.params[key] === value ? p : { ...p, params: { ...p.params, [key]: value } }), 'param:' + String(key));
}

export function updateGraphic(id: string, patch: Partial<Graphic> | ((g: Graphic) => Partial<Graphic>), key = '') {
  update(
    (p) => ({
      ...p,
      graphics: p.graphics.map((g) => (g.id === id ? { ...g, ...(typeof patch === 'function' ? patch(g) : patch) } : g)),
    }),
    key ? `g:${id}:${key}` : '',
  );
}

export function setUI(patch: Partial<UIState>) {
  uiStore.set((u) => ({ ...u, ...patch }));
}

export function toast(text: string, tone: 'ok' | 'warn' | 'error' = 'ok') {
  setUI({ toast: { text, tone, at: Date.now() } });
}
