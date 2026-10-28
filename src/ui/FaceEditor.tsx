import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FaceDef, Graphic, Shape2D } from '../core/types';
import { peekShape, resolveShape } from '../graphics/resolve';
import { placementMatrix, shapePathData } from '../graphics/shape2d';
import { setUI, update, updateGraphic, useProject, useUI } from '../state/store';
import { Icon } from './icons';
import { viewerBus } from './bus';
import { MODE_LABEL, useOutlineEpoch } from './steps/GraphicsStep';

type Drag =
  | { kind: 'move'; id: string; px: number; py: number; x0: number; y0: number; key: string }
  | { kind: 'scale'; id: string; w0: number; h0: number; key: string }
  | { kind: 'rotate'; id: string; key: string };

const GraphicPaths = memo(function GraphicPaths({ shape, fill, stroke, hatch }: { shape: Shape2D; fill: string; stroke?: string; hatch?: boolean }) {
  const paths = useMemo(() => shapePathData(shape), [shape]);
  return (
    <>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fillRule={p.fillRule} fill={fill} stroke={stroke} strokeWidth={stroke ? 1 : undefined} vectorEffect="non-scaling-stroke" />
      ))}
      {hatch &&
        paths.map((p, i) => <path key={'h' + i} d={p.d} fillRule={p.fillRule} fill="url(#fe-hatch)" />)}
    </>
  );
});

function GraphicView({ g, face }: { g: Graphic; face: FaceDef }) {
  const [shape, setShape] = useState<Shape2D | undefined>(() => peekShape(g));
  const epoch = useOutlineEpoch();
  useEffect(() => {
    let live = true;
    const now = peekShape(g);
    setShape(now);
    if (!now)
      resolveShape(g).then(
        (s) => live && setShape(s),
        () => live && setShape(undefined),
      );
    return () => {
      live = false;
    };
  }, [g, epoch]);
  void face;
  if (g.mode === 'lithophane' && g.source.kind === 'image') {
    const t = `translate(${g.x} ${g.y}) rotate(${g.rotation}) scale(${g.mirror ? -1 : 1} 1)`;
    return (
      <g transform={t}>
        <g transform="scale(1,-1)">
          <image href={g.source.dataUrl} x={-g.w / 2} y={-g.h / 2} width={g.w} height={g.h} preserveAspectRatio="none" style={{ filter: 'grayscale(1)' }} />
        </g>
        <rect x={-g.w / 2} y={-g.h / 2} width={g.w} height={g.h} fill="none" stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }
  if (!shape) {
    return (
      <rect x={g.x - g.w / 2} y={g.y - g.h / 2} width={g.w} height={g.h} fill="none" stroke="var(--ink-3)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" transform={`rotate(${g.rotation} ${g.x} ${g.y})`} />
    );
  }
  const m = placementMatrix(g, shape);
  const fill = g.mode === 'cut' ? 'var(--ink)' : g.color;
  return (
    <g transform={`matrix(${m.join(' ')})`} opacity={g.mode === 'cut' ? 0.78 : 1}>
      <GraphicPaths shape={shape} fill={fill} stroke={g.mode === 'cut' ? undefined : 'rgba(0,0,0,0.35)'} hatch={g.mode === 'deboss' || g.mode === 'inlay'} />
    </g>
  );
}

export function FaceEditor({ face, graphics }: { face: FaceDef; graphics: Graphic[] }) {
  const selectedId = useUI((u) => u.selected);
  const allGraphics = useProject((p) => p.graphics);
  const sel = allGraphics.find((g) => g.id === selectedId) ?? null;
  const svgRef = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const [angleTag, setAngleTag] = useState<number | null>(null);
  const units = useProject((p) => p.units);
  const bodyColor = useProject((p) => p.color);
  const light = luminance(bodyColor) > 0.55;
  const gridInk = light ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.16)';
  const gridInkMajor = light ? 'rgba(0,0,0,0.24)' : 'rgba(255,255,255,0.3)';

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = face.width;
  const H = face.height;
  const margin = Math.max(W, H) * 0.1 + 6;
  const vb = { x: -W / 2 - margin, y: -H / 2 - margin, w: W + 2 * margin, h: H + 2 * margin };
  const scale = Math.min(size.w / vb.w, size.h / vb.h); // px per mm
  const hs = 6 / scale; // handle half-size in mm
  const outline = face.outline.length >= 3 ? face.outline : [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
  const outlinePts = outline.map(([x, y]) => `${x},${y}`).join(' ');
  const clipId = `fe-clip-${face.id}`;

  const toFace = (e: { clientX: number; clientY: number }) => {
    const g = layer.current;
    const ctm = g?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const startMove = (e: React.PointerEvent, g: Graphic) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setUI({ selected: g.id });
    const p = toFace(e);
    setDrag({ kind: 'move', id: g.id, px: p.x, py: p.y, x0: g.x, y0: g.y, key: 'drag' + Date.now() });
    capture(e);
  };

  const capture = (e: React.PointerEvent) => {
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    svgRef.current?.focus({ preventScroll: true });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const g = graphics.find((x) => x.id === drag.id);
    if (!g) return;
    const p = toFace(e);
    const snapD = 7 / scale;
    if (drag.kind === 'move') {
      let x = drag.x0 + (p.x - drag.px);
      let y = drag.y0 + (p.y - drag.py);
      const gx = !e.altKey && Math.abs(x) < snapD;
      const gy = !e.altKey && Math.abs(y) < snapD;
      if (gx) x = 0;
      if (gy) y = 0;
      setGuides({ x: gx, y: gy });
      updateGraphic(g.id, { x: +x.toFixed(2), y: +y.toFixed(2) }, drag.key);
    } else if (drag.kind === 'scale') {
      const t = (-g.rotation * Math.PI) / 180;
      const dx = p.x - g.x, dy = p.y - g.y;
      const lx = Math.abs(dx * Math.cos(t) - dy * Math.sin(t));
      const ly = Math.abs(dx * Math.sin(t) + dy * Math.cos(t));
      let w: number, h: number;
      if (g.lockAspect) {
        const a = drag.w0 / 2, b = drag.h0 / 2;
        const s = Math.max(0.02, (lx * a + ly * b) / (a * a + b * b));
        w = drag.w0 * s;
        h = drag.h0 * s;
      } else {
        w = 2 * lx;
        h = 2 * ly;
      }
      updateGraphic(g.id, { w: +Math.max(1, w).toFixed(2), h: +Math.max(1, h).toFixed(2) }, drag.key);
    } else {
      let ang = (Math.atan2(p.y - g.y, p.x - g.x) * 180) / Math.PI - 90;
      if (ang < -180) ang += 360;
      if (!e.altKey) {
        const snapped = Math.round(ang / 15) * 15;
        if (Math.abs(snapped - ang) < 4) ang = snapped;
      }
      setAngleTag(ang);
      updateGraphic(g.id, { rotation: +ang.toFixed(1) }, drag.key);
    }
  };

  const endDrag = () => {
    setDrag(null);
    setGuides({ x: false, y: false });
    setAngleTag(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!sel || sel.faceId !== face.id) return;
    const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (map[e.key]) {
      e.preventDefault();
      const [dx, dy] = map[e.key];
      updateGraphic(sel.id, (g) => ({ x: +(g.x + dx).toFixed(2), y: +(g.y + dy).toFixed(2) }), 'nudge');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      update((p) => ({ ...p, graphics: p.graphics.filter((x) => x.id !== sel.id) }));
      setUI({ selected: null });
    } else if (e.key === 'Escape') setUI({ selected: null });
  };

  const selG = sel && sel.faceId === face.id ? sel : null;
  const gridStep = Math.max(W, H) > 160 ? 10 : 5;
  const gridLines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
  for (let x = 0; x <= W / 2 + 1e-6; x += gridStep)
    for (const sx of x === 0 ? [1] : [1, -1]) gridLines.push({ x1: sx * x, y1: -H / 2, x2: sx * x, y2: H / 2, major: Math.round(x) % 10 === 0 });
  for (let y = 0; y <= H / 2 + 1e-6; y += gridStep)
    for (const sy of y === 0 ? [1] : [1, -1]) gridLines.push({ x1: -W / 2, y1: sy * y, x2: W / 2, y2: sy * y, major: Math.round(y) % 10 === 0 });
  const fmt = (mm: number) => (units === 'in' ? (mm / 25.4).toFixed(2) + ' in' : (Math.round(mm * 10) / 10).toString() + ' mm');

  return (
    <div className="face-editor">
      <div className="fe-head">
        <h3>{face.label}</h3>
        <span className="dims">
          {fmt(W)} × {fmt(H)}
          {face.kind === 'cylinder' ? ' · wraps around' : ''}
          {face.onBed ? ' · faces the print bed' : ''}
        </span>
        <span style={{ flex: 1 }} />
        {selG && (
          <span className="dims sel-readout">
            {MODE_LABEL[selG.mode]} {fmt(selG.w)} × {fmt(selG.h)}
            {angleTag !== null ? ` · ${angleTag.toFixed(0)}°` : selG.rotation ? ` · ${selG.rotation}°` : ''}
          </span>
        )}
        <button type="button" className="btn ghost small" onClick={() => viewerBus.emit('lookAt', face.id)} title="Turn the 3D view to this face">
          <Icon name="target" /> Show in 3D
        </button>
      </div>
      <div className="fe-canvas">
        <svg
          ref={svgRef}
          tabIndex={0}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={() => setUI({ selected: null })}
          onKeyDown={onKey}
          aria-label={`${face.label} editor. Drag graphics to move them; arrow keys nudge the selected graphic.`}
          role="application"
        >
          <defs>
            <clipPath id={clipId}>
              <polygon points={outlinePts} />
            </clipPath>
            <pattern id="fe-hatch" width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={3} stroke="rgba(0,0,0,0.35)" strokeWidth={0.8} />
            </pattern>
          </defs>
          <g ref={layer} transform="scale(1,-1)">
            <polygon className="fe-face" points={outlinePts} style={{ fill: bodyColor }} />
            <g clipPath={`url(#${clipId})`}>
              {gridLines.map((l, i) => (
                <line key={i} className="fe-grid" style={{ stroke: l.major ? gridInkMajor : gridInk }} {...l} />
              ))}
            </g>
            <line className="fe-axis" x1={0} y1={-H / 2 - margin * 0.6} x2={0} y2={H / 2 + margin * 0.6} />
            <line className="fe-axis" x1={-W / 2 - margin * 0.6} y1={0} x2={W / 2 + margin * 0.6} y2={0} />
            <g className="fe-ghost">
              {graphics.filter((g) => !g.hidden).map((g) => (
                <GraphicView key={g.id} g={g} face={face} />
              ))}
            </g>
            <g clipPath={`url(#${clipId})`}>
              {graphics.filter((g) => !g.hidden).map((g) => (
                <g key={g.id} onPointerDown={(e) => startMove(e, g)} style={{ cursor: 'move' }}>
                  <GraphicView g={g} face={face} />
                  <rect x={g.x - g.w / 2} y={g.y - g.h / 2} width={g.w} height={g.h} fill="transparent" transform={`rotate(${g.rotation} ${g.x} ${g.y})`} />
                </g>
              ))}
            </g>
            {guides.x && <line className="fe-guide" x1={0} y1={-H / 2} x2={0} y2={H / 2} />}
            {guides.y && <line className="fe-guide" x1={-W / 2} y1={0} x2={W / 2} y2={0} />}
            {selG && (
              <g transform={`rotate(${selG.rotation} ${selG.x} ${selG.y})`}>
                <rect className="fe-sel" x={selG.x - selG.w / 2} y={selG.y - selG.h / 2} width={selG.w} height={selG.h} onPointerDown={(e) => startMove(e, selG)} style={{ cursor: 'move', fill: 'transparent' }} />
                <line className="fe-sel" x1={selG.x} y1={selG.y + selG.h / 2} x2={selG.x} y2={selG.y + selG.h / 2 + 18 / scale} />
                <circle
                  className="fe-handle"
                  cx={selG.x}
                  cy={selG.y + selG.h / 2 + 18 / scale}
                  r={hs * 0.95}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    capture(e);
                    setDrag({ kind: 'rotate', id: selG.id, key: 'rot' + Date.now() });
                  }}
                />
                {[
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ].map(([sx, sy]) => (
                  <rect
                    key={`${sx}${sy}`}
                    className="fe-handle"
                    x={selG.x + (sx * selG.w) / 2 - hs}
                    y={selG.y + (sy * selG.h) / 2 - hs}
                    width={hs * 2}
                    height={hs * 2}
                    style={{ cursor: sx * sy > 0 ? 'nesw-resize' : 'nwse-resize' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      capture(e);
                      setDrag({ kind: 'scale', id: selG.id, w0: selG.w, h0: selG.h, key: 'scale' + Date.now() });
                    }}
                  />
                ))}
              </g>
            )}
          </g>
        </svg>
        {graphics.length === 0 && <div className="fe-empty">Add text, an image, a shape or vents from the panel. Drag to place them here.</div>}
      </div>
    </div>
  );
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
