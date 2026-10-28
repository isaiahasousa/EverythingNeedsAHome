import { useEffect, useRef, useState } from 'react';
import { printerById } from '../export/layout';
import { useFaces } from '../state/buildController';
import { setUI, useBuild, useProject, useUI, type ViewMode } from '../state/store';
import { viewerBus } from '../ui/bus';
import { Icon } from '../ui/icons';
import { fmtLen } from '../ui/steps/BasicSteps';
import { useLayout } from '../ui/steps/ExportStep';
import { Viewer, type ViewerTheme } from './Viewer';

function readTheme(): ViewerTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { edge: v('--edge', '#0e1316'), accent: v('--accent', '#c4892b'), plate: v('--plate', '#b48f52'), plateLine: v('--plate-line', '#7c5d2b'), shadow: '#000' };
}

export function ViewerPanel() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const result = useBuild((b) => b.result);
  const status = useBuild((b) => b.status);
  const error = useBuild((b) => b.error);
  const engine = useBuild((b) => b.engine);
  const view = useUI((u) => u.view);
  const step = useUI((u) => u.step);
  const faceId = useUI((u) => u.faceId);
  const color = useProject((p) => p.color);
  const printer = useProject((p) => p.printer);
  const units = useProject((p) => p.units);
  const type = useProject((p) => p.type);
  const { resolved } = useFaces();
  const layout = useLayout();
  const [edges, setEdges] = useState(true);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let v: Viewer;
    try {
      v = new Viewer(host.current);
    } catch {
      return;
    }
    viewer.current = v;
    v.setTheme(readTheme());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => requestAnimationFrame(() => v.setTheme(readTheme()));
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const offLook = viewerBus.on('lookAt', (id) => v.lookAtFace(id));
    const offFit = viewerBus.on('fit', () => v.fit());
    return () => {
      mq.removeEventListener('change', onTheme);
      mo.disconnect();
      offLook();
      offFit();
      v.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.onPick = (fid) => {
      if (fid) setUI({ faceId: fid, selected: null, mobilePane: 'face' });
    };
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (v && result && layout) v.setParts(result.parts, result.faces, layout.matrices);
  }, [result, layout]);
  useEffect(() => viewer.current?.setView(view), [view]);
  useEffect(() => viewer.current?.setBodyColor(color), [color]);
  useEffect(() => {
    const b = printerById(printer);
    viewer.current?.setBed(b.w, b.d);
  }, [printer]);
  useEffect(() => viewer.current?.setEdges(edges), [edges]);
  const split = step === 'graphics';
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    viewer.current?.refitAfterResize();
  }, [split]);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.pickEnabled = step === 'graphics';
    v.setHighlight(step === 'graphics' ? faceId : null);
    v.onHoverFace = step === 'graphics' ? (id) => setHoverLabel(id ? result?.faces.find((f) => f.id === id)?.label ?? null : null) : null;
  }, [step, faceId, result]);

  const [ow, od, oh] = resolved.outer;
  const u = units === 'in' ? 'in' : 'mm';
  const tris = result?.parts.reduce((s, p) => s + p.triangles, 0) ?? 0;
  const busy = status === 'building' || status === 'loading';
  const views: { value: ViewMode; label: React.ReactNode; title: string }[] = [
    { value: 'assembled', label: <><Icon name="assembled" /> Closed</>, title: 'Assembled' },
    { value: 'exploded', label: <><Icon name="exploded" /> {type === 'hinged' ? 'Open' : 'Apart'}</>, title: 'Parts separated' },
    { value: 'print', label: <><Icon name="bed" /> Print bed</>, title: 'Laid out for printing' },
  ];

  return (
    <div className="viewport">
      <div ref={host} className="viewport-canvas" />
      <div className="view-toolbar">
        <div className="segmented view-modes" role="group" aria-label="View">
          {views.map((o) => (
            <button key={o.value} type="button" aria-pressed={view === o.value} title={o.title} onClick={() => setUI({ view: o.value })} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {o.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn icon small" title="Fit to view" aria-label="Fit to view" onClick={() => viewer.current?.fit()}>
          <Icon name="fit" />
        </button>
        <button type="button" className="btn icon small" title={edges ? 'Hide edges' : 'Show edges'} aria-label="Toggle edges" aria-pressed={edges} onClick={() => setEdges((e) => !e)}>
          <Icon name="edges" />
        </button>
        <span style={{ flex: 1 }} />
        <span
          className={`status-chip ${busy ? 'busy' : status === 'error' ? 'err' : ''}`}
          role="status"
          aria-live="polite"
          title={engine === 'js' ? 'This page blocks WebAssembly, so the slower JavaScript geometry engine is running. Results are identical.' : undefined}
        >
          <span className="dot" />
          {status === 'loading' ? 'Starting geometry engine…' : busy ? 'Building…' : status === 'error' ? 'Build problem' : `${tris.toLocaleString()} triangles · ${Math.round(result?.ms ?? 0)} ms${engine === 'js' ? ' · JS engine' : ''}`}
        </span>
      </div>
      <div className="caliper" aria-label="Outside dimensions">
        <div>
          <small>Width</small>
          <b>{fmtLen(ow, units)}</b>
        </div>
        <div>
          <small>Depth</small>
          <b>{fmtLen(od, units)}</b>
        </div>
        <div>
          <small>Height</small>
          <b>{fmtLen(oh, units)}</b>
        </div>
        <div>
          <small>Unit</small>
          <b>{u}</b>
        </div>
      </div>
      <div className="hint">
        {step === 'graphics' ? (hoverLabel ? `Click to decorate: ${hoverLabel}` : 'Click a face to decorate it') : 'Drag to orbit · right-drag to pan · scroll to zoom'}
      </div>
      {error && <div className="stage-error note error">{error}</div>}
      {!error && result && result.parts.length === 0 && (
        <div className="stage-error note error" role="alert">
          {result.warnings.find((w) => w.level === 'error')?.text ?? 'This combination of settings has no solid parts.'}
        </div>
      )}
    </div>
  );
}
