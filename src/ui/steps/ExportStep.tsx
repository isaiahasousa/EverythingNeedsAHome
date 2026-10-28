import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutParts, printerById, PRINTERS, soloMatrix } from '../../export/layout';
import { slug, to3MF, toSTL, zipFiles } from '../../export/meshio';
import { saveFile, savesAreZipped } from '../../export/save';
import type { PartMesh } from '../../core/types';
import { normalizeProject } from '../../state/project';
import { projectStore, replaceProject, setUI, toast, update, useBuild, useProject } from '../../state/store';
import { Select } from '../controls';
import { Icon } from '../icons';
import { fmtLen, Notes } from './BasicSteps';

const PLA_DENSITY = 1.24; // g/cm3

async function deliver(name: string, data: Uint8Array | string, mime: string) {
  const r = await saveFile(name, data, mime);
  if (r.outcome === 'saved') toast(`Saved ${r.filename}`);
  else if (r.outcome === 'unavailable') toast('Saving files is not available in this view. Open the app in its own tab to download.', 'error');
}

export function useLayout() {
  const result = useBuild((b) => b.result);
  const printer = useProject((p) => p.printer);
  return useMemo(() => (result ? layoutParts(result.parts, printerById(printer)) : null), [result, printer]);
}

export function exportAll3MF(parts: PartMesh[], matrices: Map<string, number[]>) {
  const p = projectStore.get();
  const items = parts.map((part) => ({ part, matrix: matrices.get(part.id) ?? part.print }));
  return deliver(`${slug(p.name)}.3mf`, to3MF(items, p.color, p.name), 'model/3mf');
}

export function ExportStep() {
  const result = useBuild((b) => b.result);
  const status = useBuild((b) => b.status);
  const name = useProject((p) => p.name);
  const printer = useProject((p) => p.printer);
  const units = useProject((p) => p.units);
  const layout = useLayout();
  const openRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [inArtifactHost, setZipped] = useState(false);
  useEffect(() => {
    let live = true;
    void savesAreZipped().then((z) => live && setZipped(z));
    return () => {
      live = false;
    };
  }, []);
  const parts = result?.parts ?? [];
  const bodies = parts.filter((p) => p.role === 'body');
  const inlays = parts.filter((p) => p.role === 'inlay');
  const totalVol = parts.reduce((s, p) => s + p.volume, 0) / 1000;
  // Only a finished build of the current settings can be downloaded.
  const ready = status === 'ready' && bodies.length > 0;

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const stlFor = (part: PartMesh) => {
    const items = [{ part, matrix: soloMatrix(part) }];
    for (const inl of inlays.filter((x) => x.parentId === part.id)) items.push({ part: inl, matrix: soloMatrix(part) });
    return toSTL(items, part.name);
  };

  const notes = [
    ...(status === 'building' || status === 'loading' ? [{ level: 'info' as const, text: 'Updating the model to match your latest changes. Downloads switch back on when it is done.' }] : []),
    ...(status === 'error' ? [{ level: 'error' as const, text: 'The model could not be built with these settings, so there is nothing to download. Change the settings or undo the last change.' }] : []),
    ...(layout?.overflow.length ? [{ level: 'warn' as const, text: `Too big for this bed: ${layout.overflow.join(', ')}. Choose a larger printer or print parts separately.` }] : []),
    ...(layout?.tooTall.length ? [{ level: 'warn' as const, text: `Taller than this printer allows: ${layout.tooTall.join(', ')}.` }] : []),
  ];

  return (
    <>
      <h2 className="step-title">Print it</h2>
      <p className="step-lede">Parts are laid out in their print orientation. Check the Print bed view, then download.</p>
      <Select stacked label="Printer bed" value={printer} options={PRINTERS.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { update((p) => ({ ...p, printer: v })); setUI({ view: 'print' }); }} />
      <Notes items={notes} />

      <section className="section">
        <h3 className="section-title">Downloads</h3>
        <div className="big-actions">
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => layout && run(() => exportAll3MF(parts, layout.matrices))}>
            <Icon name="download" /> All parts, ready to slice
            <span className="sub">{inArtifactHost ? '.3mf in .zip' : '.3mf'}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!ready || busy}
            onClick={() =>
              run(() => {
                const files: Record<string, Uint8Array> = {};
                for (const b of bodies) files[`${slug(name)}-${slug(b.name)}.stl`] = toSTL([{ part: b, matrix: soloMatrix(b) }], b.name);
                for (const inl of inlays) {
                  const parent = bodies.find((b) => b.id === inl.parentId);
                  if (parent) files[`${slug(name)}-${slug(inl.name)}.stl`] = toSTL([{ part: inl, matrix: soloMatrix(parent) }], inl.name);
                }
                return deliver(`${slug(name)}-stl.zip`, zipFiles(files), 'application/zip');
              })
            }
          >
            <Icon name="download" /> Every part as STL
            <span className="sub">.zip</span>
          </button>
        </div>
        {inlays.length > 0 && <div className="field-help" style={{ marginTop: 0 }}>Inlays are separate STL files placed to line up with their part. In the 3MF they arrive as one object with a part per colour.</div>}
      </section>

      <section className="section">
        <h3 className="section-title">Parts</h3>
        <ul className="parts">
          {bodies.map((p) => {
            const size = [0, 1, 2].map((i) => p.printMax[i] - p.printMin[i]);
            const vol = (p.volume + inlays.filter((x) => x.parentId === p.id).reduce((s, x) => s + x.volume, 0)) / 1000;
            return (
              <li key={p.id} className="part-row">
                <strong>{p.name}</strong>
                <button type="button" className="btn small" disabled={!ready || busy} onClick={() => run(() => deliver(`${slug(name)}-${slug(p.name)}.stl`, stlFor(p), 'model/stl'))}>
                  <Icon name="download" /> STL
                </button>
                <span className="meta">
                  {size.map((v) => fmtLen(v, units)).join(' × ')} {units} · {vol.toFixed(1)} cm³ · ~{Math.round(vol * PLA_DENSITY)} g
                </span>
                {p.tip && <span className="tip">{p.tip}</span>}
              </li>
            );
          })}
        </ul>
        {bodies.length > 0 && (
          <div className="field-help" style={{ marginTop: 0 }}>
            Total {totalVol.toFixed(1)} cm³ of plastic, about {Math.round(totalVol * PLA_DENSITY)} g of PLA if printed solid. Infill makes it lighter.
          </div>
        )}
      </section>

      <section className="section">
        <h3 className="section-title">Project</h3>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => run(() => deliver(`${slug(name)}.project.json`, JSON.stringify(projectStore.get(), null, 2), 'application/json'))}>
            <Icon name="save" /> Save project
          </button>
          <button type="button" className="btn" onClick={() => openRef.current?.click()}>
            <Icon name="open" /> Open project
          </button>
        </div>
        <input
          ref={openRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              replaceProject(normalizeProject(JSON.parse(await f.text())));
              toast(`Opened ${f.name}`);
            } catch (err) {
              toast(String((err as Error).message ?? err), 'error');
            }
          }}
        />
        {inArtifactHost && <div className="field-help" style={{ marginTop: 0 }}>Inside claude.ai, model files arrive zipped. Unzip them before slicing.</div>}
      </section>
    </>
  );
}
