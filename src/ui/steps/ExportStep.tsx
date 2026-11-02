import { useEffect, useMemo, useRef, useState } from 'react';
import { slotName } from '../../core/filaments';
import { layoutPlates, printerById, PRINTERS, soloMatrix, type Plate, type PlateLayout } from '../../export/layout';
import { slug, stlFileNames, to3MF, toSTL, zipFiles } from '../../export/meshio';
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

/** The filament slot a body prints with (a slot that was removed falls back to slot 1). */
const bodySlot = (partSlots: Record<string, number>, count: number, id: string) => Math.min(partSlots[id] ?? 0, count - 1);

/** The parts on plates: one or more plates per filament colour. */
export function useLayout() {
  const result = useBuild((b) => b.result);
  const printer = useProject((p) => p.printer);
  const partSlots = useProject((p) => p.partSlots);
  const count = useProject((p) => p.filaments.length);
  return useMemo(() => (result ? layoutPlates(result.parts, printerById(printer), (id) => bodySlot(partSlots, count, id)) : null), [result, printer, partSlots, count]);
}

/** A plate's parts placed on its bed, each with the filament slot it prints with. */
function plateItems(parts: PartMesh[], plate: Plate) {
  const p = projectStore.get();
  return parts
    .filter((part) => plate.bodies.includes(part.role === 'inlay' ? (part.parentId ?? '') : part.id))
    .map((part) => ({ part, matrix: plate.matrices.get(part.id) ?? part.print, slot: part.role === 'inlay' ? (part.slot ?? 0) : bodySlot(p.partSlots, p.filaments.length, part.id) }));
}

/** Download one plate's 3MF, or every plate: a single 3MF, or a zip with a 3MF per plate. */
export function exportPlates(parts: PartMesh[], layout: PlateLayout, only?: number) {
  const p = projectStore.get();
  const many = layout.plates.length > 1;
  const file = (k: number) => to3MF(plateItems(parts, layout.plates[k]), p.filaments, many ? `${p.name} (plate ${k + 1})` : p.name);
  if (only !== undefined) return deliver(`${slug(p.name)}-plate-${only + 1}.3mf`, file(only), 'model/3mf');
  if (!many) return deliver(`${slug(p.name)}.3mf`, file(0), 'model/3mf');
  const files = Object.fromEntries(layout.plates.map((_, k) => [`${slug(p.name)}-plate-${k + 1}.3mf`, file(k)]));
  return deliver(`${slug(p.name)}-plates.zip`, zipFiles(files), 'application/zip');
}

export function ExportStep() {
  const result = useBuild((b) => b.result);
  const status = useBuild((b) => b.status);
  const name = useProject((p) => p.name);
  const printer = useProject((p) => p.printer);
  const units = useProject((p) => p.units);
  const filaments = useProject((p) => p.filaments);
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
  const plateCount = layout?.plates.length ?? 0;
  const stlNames = useMemo(() => stlFileNames(name, parts), [name, parts]);
  // The highest filament number any part or colour inlay prints with (slot 1 is filament 1).
  const filamentsUsed = layout
    ? Math.max(1, ...layout.plates.map((plate) => plate.slot + 1), ...inlays.filter((x) => layout.plates.some((plate) => plate.bodies.includes(x.parentId ?? ''))).map((x) => (x.slot ?? 0) + 1))
    : 1;

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

  const buildNotes = useMemo(() => {
    const seen = new Set<string>();
    return (result?.warnings ?? []).filter((w) => w.level !== 'info' && !seen.has(w.text) && !!seen.add(w.text));
  }, [result]);
  const notes = [
    ...(status === 'building' || status === 'loading' ? [{ level: 'info' as const, text: 'Updating the model to match your latest changes. Downloads switch back on when it is done.' }] : []),
    ...(status === 'error' ? [{ level: 'error' as const, text: 'The model could not be built with these settings, so there is nothing to download. Change the settings or undo the last change.' }] : []),
    ...(layout?.overflow.length ? [{ level: 'warn' as const, text: `Too big for this bed: ${layout.overflow.join(', ')}. Choose a larger printer or print parts separately.` }] : []),
    ...(layout?.tooTall.length ? [{ level: 'warn' as const, text: `Taller than this printer allows: ${layout.tooTall.join(', ')}.` }] : []),
    // Everything the last build had to say (settings, graphics left out, parts in pieces), once each.
    ...(status === 'ready' ? buildNotes : []),
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
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => layout && run(() => exportPlates(parts, layout))}>
            <Icon name="download" /> {plateCount > 1 ? `All ${plateCount} plates, ready to slice` : 'All parts, ready to slice'}
            <span className="sub">{plateCount > 1 ? `${plateCount} × .3mf, .zip` : inArtifactHost ? '.3mf in .zip' : '.3mf'}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!ready || busy}
            onClick={() =>
              run(() => {
                const files: Record<string, Uint8Array> = {};
                for (const b of bodies) files[stlNames.get(b.id)!] = toSTL([{ part: b, matrix: soloMatrix(b) }], b.name);
                for (const inl of inlays) {
                  const parent = bodies.find((b) => b.id === inl.parentId);
                  const file = stlNames.get(inl.id);
                  if (parent && file) files[file] = toSTL([{ part: inl, matrix: soloMatrix(parent) }], inl.name);
                }
                return deliver(`${slug(name)}-stl.zip`, zipFiles(files), 'application/zip');
              })
            }
          >
            <Icon name="download" /> Every part as STL
            <span className="sub">.zip</span>
          </button>
        </div>
        {inlays.length > 0 && (
          <div className="field-help" style={{ marginTop: 0 }}>
            Colour inlays are separate STL files placed to line up with their part. In the 3MF each part arrives as one object, with a part per colour inlay set to its AMS slot.
          </div>
        )}
      </section>

      {layout && plateCount > 0 && (
        <section className="section">
          <h3 className="section-title">Plates</h3>
          <ul className="parts">
            {layout.plates.map((plate, k) => {
              const names = plate.bodies.map((id) => bodies.find((b) => b.id === id)?.name ?? id);
              const extra = [...new Set(inlays.filter((x) => plate.bodies.includes(x.parentId ?? '')).map((x) => x.slot ?? 0))].filter((s) => s !== plate.slot);
              return (
                <li key={k} className="part-row">
                  <strong>
                    <span className="slot-dot" style={{ background: filaments[plate.slot] }} /> Plate {k + 1}
                  </strong>
                  {plateCount > 1 && (
                    <button type="button" className="btn small" disabled={!ready || busy} onClick={() => run(() => exportPlates(parts, layout, k))}>
                      <Icon name="download" /> 3MF
                    </button>
                  )}
                  <span className="meta">
                    {names.join(', ')} in {slotName(filaments, plate.slot)}
                    {extra.length > 0 && <>, with inlays in {extra.map((s) => slotName(filaments, s)).join(', ')}</>}
                  </span>
                </li>
              );
            })}
          </ul>
          {plateCount > 1 && (
            <div className="field-help" style={{ marginTop: 0 }}>
              Parts in different colours print on separate plates, so the AMS only changes filament for colour inlays. Choose part colours in the Details step.
            </div>
          )}
          {filamentsUsed > 1 && (
            <div className="field-help" style={{ marginTop: 0 }}>
              Each part opens in Bambu Studio set to its slot&apos;s filament number (slot 1 is filament 1). Sync your AMS in Bambu Studio first, so the project has at least {filamentsUsed} filaments: a part set to a number the project doesn&apos;t have prints with filament 1.
            </div>
          )}
        </section>
      )}

      <section className="section">
        <h3 className="section-title">Parts</h3>
        <ul className="parts">
          {bodies.map((p) => {
            const size = [0, 1, 2].map((i) => p.printMax[i] - p.printMin[i]);
            const vol = (p.volume + inlays.filter((x) => x.parentId === p.id).reduce((s, x) => s + x.volume, 0)) / 1000;
            return (
              <li key={p.id} className="part-row">
                <strong>{p.name}</strong>
                <button type="button" className="btn small" disabled={!ready || busy} onClick={() => run(() => deliver(stlNames.get(p.id) ?? `${slug(name)}-${slug(p.name)}.stl`, stlFor(p), 'model/stl'))}>
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
