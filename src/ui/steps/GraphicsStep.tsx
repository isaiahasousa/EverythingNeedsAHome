import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FaceDef, Graphic, GraphicMode, GraphicSource, PatternKind, ShapeKind } from '../../core/types';
import { imageAspect } from '../../graphics/raster';
import { onOutlineEpoch, outlineEpoch, peekShape, resolveShape, shapeError } from '../../graphics/resolve';
import { shapePathData, shapeSize } from '../../graphics/shape2d';
import { builtinShape, PATTERNS, SHAPES } from '../../graphics/shapes';
import { customFontName, FONTS, fontUrl, registerCustomFont } from '../../graphics/text';
import { graphicsOnFace, useFaces } from '../../state/buildController';
import { FILAMENTS, newGraphic, withFont } from '../../state/project';
import { projectStore, setUI, toast, update, updateGraphic, useBuild, useProject, useUI } from '../../state/store';
import { NumberField, Segmented, Select, Slider, Swatches, Toggle } from '../controls';
import { Icon, ModeIcon, type IconName } from '../icons';
import { lengthProps } from '../ParamField';
import { Notes } from './BasicSteps';

export const MODE_LABEL: Record<GraphicMode, string> = {
  emboss: 'Raised',
  deboss: 'Engraved',
  cut: 'Cut out',
  inlay: 'Inlay',
  lithophane: 'Lithophane',
};

const MODE_HELP: Record<GraphicMode, string> = {
  emboss: 'Stands out from the surface. Keep it under 1 mm on walls so the overhang prints cleanly.',
  deboss: 'Engraved into the surface. Prints cleanly in any orientation.',
  cut: 'Cuts all the way through the wall: windows, vents, stencils.',
  inlay: 'Engraved pocket plus a matching fill part for a second filament colour. Exports as one multi-part object in the 3MF.',
  lithophane: 'The image becomes a thin relief that shows the picture when light shines through. Print in white.',
};

export function graphicName(g: Graphic): string {
  const s = g.source;
  switch (s.kind) {
    case 'text':
      return s.text.replace(/\s+/g, ' ').trim() || 'Text';
    case 'svg':
    case 'image':
      return s.name || 'Image';
    case 'shape':
      return SHAPES.find((x) => x.kind === s.shape)?.label ?? 'Shape';
    case 'pattern':
      return `${PATTERNS.find((x) => x.kind === s.pattern)?.label ?? 'Pattern'} vent`;
  }
}

export function GraphicThumb({ g }: { g: Graphic }) {
  const shape = peekShape(g);
  if (g.source.kind === 'image' && g.mode === 'lithophane')
    return <img className="gthumb" src={g.source.dataUrl} alt="" style={{ objectFit: 'contain', filter: 'grayscale(1)' }} />;
  if (!shape || !shape.layers.length) {
    const icon: IconName = g.source.kind === 'text' ? 'text' : g.source.kind === 'pattern' ? 'pattern' : g.source.kind === 'shape' ? 'shape' : 'image';
    return (
      <span className="gthumb">
        <Icon name={icon} />
      </span>
    );
  }
  const { minX, minY, maxX, maxY } = shape.bounds;
  const pad = Math.max(maxX - minX, maxY - minY) * 0.06;
  return (
    <svg className="gthumb" viewBox={`${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`} aria-hidden="true">
      <g transform="scale(1,-1)">
        {shapePathData(shape).map((l, i) => (
          <path key={i} d={l.d} fillRule={l.fillRule} fill="currentColor" />
        ))}
      </g>
    </svg>
  );
}

const currentGraphic = (id: string) => projectStore.get().graphics.find((x) => x.id === id);

/** Size a new graphic to sit comfortably on the face. */
function fitToFace(face: FaceDef, aspect: number, share = 0.6): { w: number; h: number } {
  const maxW = (face.kind === 'cylinder' ? Math.min(face.width, (face.radius ?? 20) * 2) : face.width) * share;
  const maxH = face.height * share;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { w: Math.max(2, +w.toFixed(2)), h: Math.max(2, +h.toFixed(2)) };
}

/**
 * Width / height of a graphic's outline. An image that traces to nothing at its current threshold
 * falls back to the picture's own proportions, so it can still be placed and then adjusted.
 */
async function graphicAspect(g: Graphic): Promise<{ aspect: number; traced: boolean }> {
  if (g.source.kind === 'image' && g.mode === 'lithophane') return { aspect: await imageAspect(g.source.dataUrl), traced: true };
  try {
    const [bw, bh] = shapeSize(await resolveShape(g));
    return { aspect: bw / bh, traced: true };
  } catch (e) {
    if (g.source.kind !== 'image') throw e;
    return { aspect: await imageAspect(g.source.dataUrl), traced: false };
  }
}

const UNTRACED = 'Nothing solid was found in this image yet. Adjust Threshold or Invert until the preview shows the shape you want.';

async function addGraphic(face: FaceDef, source: GraphicSource, over: Partial<Graphic> = {}) {
  const g = newGraphic(face.id, source, over);
  if (source.kind !== 'pattern') {
    try {
      const { aspect, traced } = await graphicAspect(g);
      Object.assign(g, fitToFace(face, aspect, source.kind === 'text' ? 0.7 : 0.5));
      if (!traced) toast(UNTRACED, 'warn');
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
      return;
    }
  } else {
    Object.assign(g, fitToFace(face, face.width / Math.max(1, face.height), 0.55), { lockAspect: false });
  }
  update((p) => ({ ...p, graphics: [...p.graphics, g] }));
  setUI({ selected: g.id, faceId: face.id });
}

/** Read an uploaded file into a graphic source. Large photos are scaled down to keep projects small. */
export async function fileToSource(file: File): Promise<GraphicSource> {
  const name = file.name.replace(/\.[^.]+$/, '');
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return { kind: 'svg', name, svg: await file.text() };
  if (!file.type.startsWith('image/')) throw new Error('Use a PNG, JPG, WebP, GIF or SVG file.');
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('The image could not be decoded.'));
    i.src = url;
  });
  const max = 1024;
  let dataUrl = url;
  if (Math.max(img.naturalWidth, img.naturalHeight) > max) {
    const s = max / Math.max(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    dataUrl = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
  }
  return { kind: 'image', name, dataUrl, threshold: 128, invert: false, detail: 3 };
}

export async function addFiles(files: File[], face: FaceDef) {
  for (const f of files) {
    try {
      const src = await fileToSource(f);
      await addGraphic(face, src, { mode: 'deboss' });
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    }
  }
}

let fontFacesLoaded: Promise<void> | null = null;
function loadFontFaces() {
  if (!fontFacesLoaded)
    fontFacesLoaded = Promise.all(
      FONTS.map(async (f) => {
        const buf = await fetch(fontUrl(f.file)).then((r) => r.arrayBuffer());
        const face = new FontFace(f.css, buf);
        await face.load();
        document.fonts.add(face);
      }),
    ).then(
      () => undefined,
      () => undefined,
    );
  return fontFacesLoaded;
}

/** Changes when cached outlines were dropped (a font arrived); outline views resolve again on it. */
export function useOutlineEpoch() {
  return useSyncExternalStore(onOutlineEpoch, outlineEpoch);
}

function useShapeVersion(g: Graphic | null) {
  const [, force] = useState(0);
  const epoch = useOutlineEpoch();
  useEffect(() => {
    if (!g) return;
    let live = true;
    resolveShape(g).then(
      () => live && force((n) => n + 1),
      () => live && force((n) => n + 1),
    );
    return () => {
      live = false;
    };
  }, [g, epoch]);
}

// ------------------------------------------------------------------ step

export function GraphicsStep() {
  const { faces } = useFaces();
  const graphics = useProject((p) => p.graphics);
  const faceId = useUI((u) => u.faceId);
  const selected = useUI((u) => u.selected);
  const result = useBuild((b) => b.result);
  const warnings = useMemo(() => result?.warnings.filter((w) => w.scope === 'graphics') ?? [], [result]);
  const face = faces.find((f) => f.id === faceId) ?? null;

  useEffect(() => {
    if (!face && faces.length) {
      const withG = faces.find((f) => graphics.some((g) => g.faceId === f.id));
      setUI({ faceId: (withG ?? faces[0]).id });
    }
  }, [face, faces, graphics]);

  const onFace = face ? graphicsOnFace(graphics, face.id) : [];
  const sel = graphics.find((g) => g.id === selected) ?? null;
  const orphans = graphics.filter((g) => !faces.some((f) => f.id === g.faceId));
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <h2 className="step-title">Graphics</h2>
      <p className="step-lede">Click a face on the model or choose one below, then add text, images or shapes.</p>
      <div className="face-chips" role="group" aria-label="Faces">
        {faces.map((f) => {
          const n = graphics.filter((g) => g.faceId === f.id).length;
          return (
            <button key={f.id} type="button" className="chip" aria-pressed={f.id === faceId} onClick={() => setUI({ faceId: f.id, selected: null })}>
              {f.label}
              {n > 0 && <span className="count">{n}</span>}
            </button>
          );
        })}
      </div>

      {face && (
        <section className="section">
          <h3 className="section-title">Add to {face.label.toLowerCase()}</h3>
          <div className="add-grid">
            <button type="button" className="btn" onClick={() => addGraphic(face, { kind: 'text', text: 'LABEL', font: 'archivo-black', align: 'center', lineSpacing: 1.1, letterSpacing: 0.02 }, { mode: 'deboss' })}>
              <Icon name="text" />
              Text
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Icon name="image" />
              Image
            </button>
            <button type="button" className="btn" onClick={() => addGraphic(face, { kind: 'shape', shape: 'star', sides: 5, ratio: 0.45, corner: 0.15 }, { mode: 'deboss' })}>
              <Icon name="shape" />
              Shape
            </button>
            <button type="button" className="btn" onClick={() => addGraphic(face, { kind: 'pattern', pattern: 'hex', cell: 5, web: 1.6 }, { mode: 'cut' })}>
              <Icon name="pattern" />
              Vents
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void addFiles(files, face);
            }}
          />
          {onFace.length === 0 ? (
            <div className="empty">No graphics on this face yet. You can also drop or paste an image anywhere.</div>
          ) : (
            <ul className="glist" role="listbox" aria-label={`Graphics on ${face.label}`}>
              {onFace.map((g) => (
                <GraphicRow key={g.id} g={g} selected={g.id === selected} />
              ))}
            </ul>
          )}
        </section>
      )}

      {sel && face && sel.faceId === face.id && <Inspector g={sel} face={face} faces={faces} />}

      {orphans.length > 0 && (
        <section className="section">
          <h3 className="section-title">Not on this box</h3>
          <p className="field-help" style={{ margin: 0 }}>
            These graphics belong to faces this box type does not have. Move them or they stay hidden.
          </p>
          {orphans.map((g) => (
            <Select
              key={g.id}
              label={graphicName(g)}
              value=""
              options={[{ value: '', label: 'Move to…' }, ...faces.map((f) => ({ value: f.id, label: f.label }))]}
              onChange={(v) => v && updateGraphic(g.id, { faceId: v, x: 0, y: 0 })}
            />
          ))}
        </section>
      )}
      <Notes items={warnings} />
    </>
  );
}

function GraphicRow({ g, selected }: { g: Graphic; selected: boolean }) {
  useShapeVersion(g);
  return (
    <li className={`gitem ${g.hidden ? 'hidden-g' : ''}`} role="option" aria-selected={selected} onClick={() => setUI({ selected: g.id })}>
      <GraphicThumb g={g} />
      <span className="gname">{graphicName(g)}</span>
      <span className="gmode">{MODE_LABEL[g.mode]}</span>
      <span style={{ display: 'flex' }}>
        <button
          type="button"
          className="btn ghost icon small"
          aria-label={g.hidden ? 'Show' : 'Hide'}
          title={g.hidden ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation();
            updateGraphic(g.id, { hidden: !g.hidden });
          }}
        >
          <Icon name={g.hidden ? 'eyeOff' : 'eye'} />
        </button>
        <button
          type="button"
          className="btn ghost icon small"
          aria-label="Delete"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            update((p) => ({ ...p, graphics: p.graphics.filter((x) => x.id !== g.id) }));
          }}
        >
          <Icon name="trash" />
        </button>
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ inspector

function Inspector({ g, face, faces }: { g: Graphic; face: FaceDef; faces: FaceDef[] }) {
  const units = useProject((p) => p.units);
  useShapeVersion(g);
  const err = shapeError(g);
  const L = lengthProps(units, 0.5);
  const set = (patch: Partial<Graphic>, key: string) => updateGraphic(g.id, patch, key);
  const setW = (w: number) => set(g.lockAspect ? { w, h: +(w * (g.h / g.w)).toFixed(3) } : { w }, 'w');
  const setH = (h: number) => set(g.lockAspect ? { h, w: +(h * (g.w / g.h)).toFixed(3) } : { h }, 'h');
  const isImage = g.source.kind === 'image';
  const modes: GraphicMode[] = ['emboss', 'deboss', 'cut', 'inlay', 'lithophane'];
  const maxDepth = Math.max(0.2, face.thickness);
  /** Why an effect can't be used here, or null when it can. */
  const unavailable = (m: GraphicMode) =>
    face.solid && (m === 'cut' || m === 'lithophane') ? `${face.label} is solid underneath, so nothing can cut through it` : m === 'lithophane' && !isImage ? 'Lithophanes need a photo' : null;

  /**
   * After the outline changes shape (new text, font), keep the height and follow the new aspect. Uses the
   * edit's own undo key, so typing a word stays one undo step.
   */
  const refit = async (next: Graphic, keep: 'h' | 'w', key: string) => {
    try {
      const s = await resolveShape(next);
      // An undo (or another edit) may have changed the graphic meanwhile; then this size is stale.
      if (currentGraphic(g.id)?.source !== next.source) return;
      const [bw, bh] = shapeSize(s);
      updateGraphic(g.id, keep === 'h' ? { w: +((next.h * bw) / bh).toFixed(3) } : { h: +((next.w * bh) / bw).toFixed(3) }, key);
    } catch {
      /* error shown inline */
    }
  };
  const setSource = (patch: Partial<GraphicSource>, key: string, refitKeep?: 'h' | 'w') => {
    const next = { ...g, source: { ...g.source, ...patch } as GraphicSource };
    updateGraphic(g.id, { source: next.source }, key);
    if (refitKeep && next.lockAspect) void refit(next, refitKeep, key);
  };
  /** Lithophanes take the photo's proportions, other effects the traced outline's: refit when that changes. */
  const setMode = async (m: GraphicMode) => {
    set({ mode: m, depth: m === 'emboss' ? Math.min(g.depth, 1) : g.depth }, 'mode');
    if (g.source.kind !== 'image' || (m === 'lithophane') === (g.mode === 'lithophane')) return;
    if (m !== 'lithophane' && !g.lockAspect) return;
    try {
      const { aspect } = await graphicAspect({ ...g, mode: m });
      if (currentGraphic(g.id)?.mode !== m) return;
      updateGraphic(g.id, { h: Math.max(1, +(g.w / aspect).toFixed(2)) }, 'mode');
    } catch {
      /* the outline error shows inline */
    }
  };

  return (
    <section className="inspector" aria-label="Selected graphic">
      <SourceFields g={g} setSource={setSource} />
      {err && <div className="note error">{err}</div>}

      <div className="section">
        <h3 className="section-title">Effect</h3>
        <div className="mode-grid" role="group" aria-label="Effect">
          {modes.map((m) => (
            <button key={m} type="button" aria-pressed={g.mode === m} disabled={unavailable(m) !== null} title={unavailable(m) ?? MODE_LABEL[m]} onClick={() => void setMode(m)}>
              <ModeIcon mode={m} />
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="field-help" style={{ marginTop: 0 }}>{MODE_HELP[g.mode]}</div>
        {(g.mode === 'emboss' || g.mode === 'deboss' || g.mode === 'inlay') && (
          <NumberField label={g.mode === 'emboss' ? 'Height' : 'Depth'} value={g.depth} min={0.1} max={g.mode === 'emboss' ? 10 : maxDepth + 2} {...lengthProps(units, 0.1)} onChange={(v) => set({ depth: v }, 'depth')} />
        )}
        {g.mode === 'lithophane' && (
          <>
            <NumberField label="Thinnest (white)" value={g.lithoMin} min={0.4} max={5} {...lengthProps(units, 0.1)} onChange={(v) => set({ lithoMin: v }, 'lmin')} />
            <NumberField label="Thickest (black)" value={g.lithoMax} min={0.8} max={8} {...lengthProps(units, 0.1)} onChange={(v) => set({ lithoMax: v }, 'lmax')} />
          </>
        )}
        {g.mode !== 'lithophane' && (
          <div>
            <div className="field-label static" style={{ marginBottom: 6 }}>
              {g.mode === 'inlay' ? 'Inlay filament' : 'Preview colour'}
            </div>
            <Swatches label="Graphic colour" value={g.color} colors={FILAMENTS} onChange={(hex) => set({ color: hex }, 'color')} />
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section-title">Placement</h3>
        <div className="pair">
          <NumberField label="W" value={g.w} min={1} max={1000} {...L} onChange={setW} />
          <NumberField label="H" value={g.h} min={1} max={1000} {...L} onChange={setH} />
          <NumberField label="X" value={g.x} min={-1000} max={1000} {...L} onChange={(x) => set({ x }, 'x')} />
          <NumberField label="Y" value={g.y} min={-1000} max={1000} {...L} onChange={(y) => set({ y }, 'y')} />
        </div>
        <NumberField label="Rotation" value={g.rotation} min={-360} max={360} step={5} unit="°" decimals={1} onChange={(r) => set({ rotation: r }, 'rot')} />
        <div className="btn-row">
          <button type="button" className="btn small" aria-pressed={g.lockAspect} onClick={() => set({ lockAspect: !g.lockAspect }, '')} title="Keep proportions">
            <Icon name={g.lockAspect ? 'lock' : 'unlock'} /> {g.lockAspect ? 'Proportional' : 'Free'}
          </button>
          <button type="button" className="btn small" onClick={() => set({ mirror: !g.mirror }, '')} aria-pressed={g.mirror}>
            <Icon name="mirror" /> Mirror
          </button>
          <button type="button" className="btn small" onClick={() => set({ x: 0, y: 0 }, '')}>
            <Icon name="target" /> Centre
          </button>
        </div>
      </div>

      <div className="section">
        <Select label="Face" value={g.faceId} options={faces.map((f) => ({ value: f.id, label: f.label }))} onChange={(v) => { updateGraphic(g.id, { faceId: v, x: 0, y: 0 }); setUI({ faceId: v }); }} />
        <div className="btn-row">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              const copy = { ...g, id: 'g' + Math.random().toString(36).slice(2, 9), x: g.x + 4, y: g.y - 4 };
              update((p) => ({ ...p, graphics: [...p.graphics, copy] }));
              setUI({ selected: copy.id });
            }}
          >
            <Icon name="copy" /> Duplicate
          </button>
          <button type="button" className="btn small" onClick={() => update((p) => ({ ...p, graphics: p.graphics.filter((x) => x.id !== g.id) }))}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </div>
    </section>
  );
}

function SourceFields({ g, setSource }: { g: Graphic; setSource: (patch: Partial<GraphicSource>, key: string, refit?: 'h' | 'w') => void }) {
  const s = g.source;
  const [fontsReady, setFontsReady] = useState(false);
  const fontFile = useRef<HTMLInputElement>(null);
  const replace = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.kind === 'text') void loadFontFaces().then(() => setFontsReady(true));
  }, [s.kind]);

  if (s.kind === 'text') {
    const multi = s.text.includes('\n');
    return (
      <div className="section">
        <h3 className="section-title">Text</h3>
        <textarea id="graphic-text" className="text-input" rows={2} value={s.text} onChange={(e) => setSource({ text: e.target.value }, 'text', 'h')} aria-label="Text" />
        <div className="font-list" role="listbox" aria-label="Font">
          {FONTS.map((f) => (
            <button key={f.id} type="button" role="option" aria-pressed={s.font === f.id} aria-selected={s.font === f.id} onClick={() => setSource({ font: f.id }, 'font', 'h')}>
              <span className="fname" style={{ fontFamily: fontsReady ? `'${f.css}', var(--font-body)` : undefined }}>
                {f.label}
              </span>
              <span className="fnote">{f.note}</span>
            </button>
          ))}
          {s.font.startsWith('custom:') && (
            <button type="button" aria-pressed>
              <span className="fname">{customFontName(s.font)}</span>
              <span className="fnote">Your font, saved with the project</span>
            </button>
          )}
        </div>
        <button type="button" className="btn small" onClick={() => fontFile.current?.click()}>
          <Icon name="upload" /> Use my own font
        </button>
        <input
          ref={fontFile}
          type="file"
          accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const buf = await f.arrayBuffer();
              if (buf.byteLength > 8 * 1024 * 1024) {
                toast('That font file is over 8 MB. Use a smaller font, or a subset of it.', 'error');
                return;
              }
              const font = await registerCustomFont(buf, f.name.replace(/\.[^.]+$/, ''));
              // Saved with the project (same undo step as switching the text to it).
              update((p) => ({ ...p, fonts: withFont(p, font) }), `g:${g.id}:font`);
              setSource({ font: font.id }, 'font', 'h');
            } catch {
              toast('That font file could not be read. Use TTF, OTF or WOFF (not WOFF2).', 'error');
            }
          }}
        />
        {multi && (
          <Segmented
            label="Alignment"
            value={s.align}
            onChange={(v) => setSource({ align: v }, 'align', 'h')}
            options={[
              { value: 'left', label: <Icon name="alignLeft" title="Left" /> },
              { value: 'center', label: <Icon name="alignCenter" title="Centre" /> },
              { value: 'right', label: <Icon name="alignRight" title="Right" /> },
            ]}
          />
        )}
        <Slider label="Letter spacing" value={s.letterSpacing} min={-0.1} max={0.5} step={0.01} format={(v) => v.toFixed(2) + ' em'} onChange={(v) => setSource({ letterSpacing: v }, 'ls', 'h')} />
        {multi && <Slider label="Line spacing" value={s.lineSpacing} min={0.7} max={2} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => setSource({ lineSpacing: v }, 'lsp', 'h')} />}
      </div>
    );
  }
  if (s.kind === 'image' || s.kind === 'svg') {
    return (
      <div className="section">
        <h3 className="section-title">{s.kind === 'svg' ? 'Vector image' : 'Image'}</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {s.kind === 'image' && <img src={s.dataUrl} alt="" style={{ width: 54, height: 40, objectFit: 'contain', background: 'var(--panel)', borderRadius: 4, border: '1px solid var(--line)' }} />}
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
        </div>
        {s.kind === 'image' && g.mode !== 'lithophane' && (
          <>
            <Slider label="Threshold" value={s.threshold} min={8} max={248} step={1} onChange={(v) => setSource({ threshold: v }, 'thr', 'w')} />
            <Toggle label="Invert (light parts become solid)" checked={s.invert} onChange={(v) => setSource({ invert: v }, 'inv', 'w')} />
            <Slider label="Detail" value={s.detail} min={1} max={5} step={1} onChange={(v) => setSource({ detail: v }, 'det', 'w')} />
          </>
        )}
        <button type="button" className="btn small" onClick={() => replace.current?.click()}>
          <Icon name="upload" /> Replace
        </button>
        <input
          ref={replace}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const src = await fileToSource(f);
              const patch: Partial<Graphic> = { source: src, mode: src.kind === 'svg' && g.mode === 'lithophane' ? 'deboss' : g.mode };
              // Keep the width and follow the new picture's proportions instead of stretching it.
              if (g.lockAspect) {
                try {
                  const { aspect, traced } = await graphicAspect({ ...g, ...patch });
                  patch.h = Math.max(1, +(g.w / aspect).toFixed(3));
                  if (!traced) toast(UNTRACED, 'warn');
                } catch {
                  /* the outline error shows inline */
                }
              }
              updateGraphic(g.id, patch);
            } catch (err) {
              toast(String((err as Error).message ?? err), 'error');
            }
          }}
        />
      </div>
    );
  }
  if (s.kind === 'shape') {
    return (
      <div className="section">
        <h3 className="section-title">Shape</h3>
        <div className="shape-grid" role="group" aria-label="Shape">
          {SHAPES.map((sh) => (
            <button key={sh.kind} type="button" title={sh.label} aria-label={sh.label} aria-pressed={s.shape === sh.kind} onClick={() => setSource({ shape: sh.kind as ShapeKind }, 'shape', 'h')}>
              <ShapeGlyph kind={sh.kind} />
            </button>
          ))}
        </div>
        {(s.shape === 'polygon' || s.shape === 'star') && (
          <NumberField label={s.shape === 'star' ? 'Points' : 'Sides'} value={s.sides} min={3} max={24} integer decimals={0} onChange={(v) => setSource({ sides: v }, 'sides', 'h')} />
        )}
        {(s.shape === 'star' || s.shape === 'ring') && <Slider label={s.shape === 'star' ? 'Inner radius' : 'Hole size'} value={s.ratio} min={0.15} max={0.9} step={0.01} format={(v) => Math.round(v * 100) + '%'} onChange={(v) => setSource({ ratio: v }, 'ratio')} />}
        {s.shape === 'rect' && <Slider label="Corner rounding" value={s.corner} min={0} max={1} step={0.01} format={(v) => Math.round(v * 100) + '%'} onChange={(v) => setSource({ corner: v }, 'corner')} />}
      </div>
    );
  }
  return (
    <div className="section">
      <h3 className="section-title">Vent pattern</h3>
      <Select label="Holes" value={s.pattern} options={PATTERNS.map((p) => ({ value: p.kind, label: p.label }))} onChange={(v) => setSource({ pattern: v as PatternKind }, 'pat')} />
      <NumberField label="Hole size" value={s.cell} min={1} max={40} step={0.5} unit="mm" onChange={(v) => setSource({ cell: v }, 'cell')} />
      <NumberField label="Web between holes" value={s.web} min={0.6} max={20} step={0.1} unit="mm" onChange={(v) => setSource({ web: v }, 'web')} />
      <div className="field-help" style={{ marginTop: 0 }}>Only whole holes that fit inside the W × H area are cut.</div>
    </div>
  );
}

function ShapeGlyph({ kind }: { kind: ShapeKind }) {
  const s = builtinShape(kind, kind === 'polygon' ? 6 : 5, 0.45, 0.25);
  const { minX, minY, maxX, maxY } = s.bounds;
  const w = maxX - minX, h = maxY - minY;
  const m = Math.max(w, h) * 0.08;
  return (
    <svg viewBox={`${minX - m} ${-maxY - m} ${w + 2 * m} ${h + 2 * m}`} aria-hidden="true">
      <g transform="scale(1,-1)">
        {shapePathData(s).map((l, i) => (
          <path key={i} d={l.d} fillRule={l.fillRule} fill="currentColor" />
        ))}
      </g>
    </svg>
  );
}
