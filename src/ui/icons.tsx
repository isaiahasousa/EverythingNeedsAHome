import type { ReactNode } from 'react';
import type { BoxTypeId, GraphicMode } from '../core/types';

const P = {
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  download: <><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
  upload: <><path d="M12 20V9" /><path d="m7 14 5-5 5 5" /><path d="M5 4h14" /></>,
  text: <><path d="M5 7V4h14v3" /><path d="M12 4v16" /><path d="M9 20h6" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></>,
  shape: <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" />,
  pattern: <><path d="m7 4 3 1.7v3.6L7 11 4 9.3V5.7Z" /><path d="m17 4 3 1.7v3.6L17 11l-3-1.7V5.7Z" /><path d="m12 12.5 3 1.7v3.6L12 19.5l-3-1.7v-3.6Z" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><path d="m4 4 16 16" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="m6 7 1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.6-1.7" /></>,
  mirror: <><path d="M12 3v18" strokeDasharray="2 2.5" /><path d="M9 7 3 17h6Z" /><path d="m15 7 6 10h-6Z" /></>,
  fit: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
  assembled: <><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9Z" /><path d="M3.5 7.5 12 12l8.5-4.5" /><path d="M12 12v9" /></>,
  exploded: <><path d="M12 2.5 5 6l7 3.5L19 6Z" /><path d="M5 12.5v4.5l7 3.5 7-3.5v-4.5" /><path d="m5 12.5 7 3.5 7-3.5" /></>,
  bed: <><path d="m2.5 16 9.5-4 9.5 4-9.5 4Z" /><path d="M8.5 14.5V9l3.5-1.6L15.5 9v5.5" /></>,
  target: <><circle cx="12" cy="12" r="6.5" /><path d="M12 2.5v4" /><path d="M12 17.5v4" /><path d="M2.5 12h4" /><path d="M17.5 12h4" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  open: <><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V10H3Z" /><path d="M3 10h18l-2 9H5Z" /></>,
  save: <><path d="M5 3.5h11l3 3V20.5H5Z" /><path d="M8 3.5v5h8v-5" /><path d="M8 20.5v-7h8v7" /></>,
  left: <path d="m15 5-7 7 7 7" />,
  right: <path d="m9 5 7 7-7 7" />,
  alignLeft: <><path d="M4 6h16" /><path d="M4 10h10" /><path d="M4 14h16" /><path d="M4 18h10" /></>,
  alignCenter: <><path d="M4 6h16" /><path d="M7 10h10" /><path d="M4 14h16" /><path d="M7 18h10" /></>,
  alignRight: <><path d="M4 6h16" /><path d="M10 10h10" /><path d="M4 14h16" /><path d="M10 18h10" /></>,
  rotate: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M20 4.5v5h-5" /></>,
  edges: <><path d="M4 8 12 4l8 4v8l-8 4-8-4Z" strokeDasharray="0" /><path d="M4 8l8 4 8-4" /><path d="M12 12v8" /></>,
  reset: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4.5v4h4" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof P;

export function Icon({ name, title }: { name: IconName; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {P[name]}
    </svg>
  );
}

/** Cross-section diagrams of a wall for each graphic mode. */
export function ModeIcon({ mode }: { mode: GraphicMode }) {
  const wall = 'var(--line-strong)';
  const ink = 'var(--accent)';
  const shapes: Record<GraphicMode, ReactNode> = {
    emboss: <><rect x="1" y="10" width="28" height="7" fill={wall} /><rect x="10" y="5" width="10" height="5.4" fill={ink} /></>,
    deboss: <><path d="M1 8h9v4h10V8h9v9H1Z" fill={wall} /><path d="M10 8h10v4H10Z" fill="none" stroke={ink} strokeDasharray="1.5 1.2" /></>,
    cut: <><rect x="1" y="8" width="9" height="9" fill={wall} /><rect x="20" y="8" width="9" height="9" fill={wall} /><path d="M15 3v13" stroke={ink} strokeWidth="1.4" /><path d="m12.5 13.5 2.5 3 2.5-3" stroke={ink} strokeWidth="1.4" fill="none" /></>,
    inlay: <><path d="M1 8h9v4h10V8h9v9H1Z" fill={wall} /><rect x="10" y="8" width="10" height="4" fill={ink} /></>,
    lithophane: <><path d="M1 8h28v2.5c-3 0-3 4-6 4s-3-3-6-3-3 4.5-6 4.5-3-3-6-3-2.5 2-4 2Z" fill={wall} /><path d="M6 1.5v3M15 1v3.5M24 1.5v3" stroke={ink} strokeWidth="1.3" /></>,
  };
  return (
    <svg viewBox="0 0 30 18" aria-hidden="true">
      {shapes[mode]}
    </svg>
  );
}

// ------------------------------------------------------------ isometric box icons

type P3 = [number, number, number];
interface Face {
  pts: P3[];
  cls: 'iso-top' | 'iso-left' | 'iso-right';
}

const C30 = Math.cos(Math.PI / 6);
const proj = ([x, y, z]: P3): [number, number] => [(x + y) * C30, (x - y) * 0.5 - z];
const VIEW: P3 = [1, -1, 1];

function solid(faces: P3[][], xf: (p: P3) => P3 = (p) => p): Face[] {
  const out: Face[] = [];
  for (const raw of faces) {
    const pts = raw.map(xf);
    const [a, b, c] = pts;
    const u: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: P3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: P3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * VIEW[0] + n[1] * VIEW[1] + n[2] * VIEW[2] <= 1e-6) continue;
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const cls = az >= ax && az >= ay ? 'iso-top' : ay >= ax ? 'iso-left' : 'iso-right';
    out.push({ pts, cls });
  }
  return out;
}

/** Axis-aligned box as six outward-wound faces. */
function cuboid(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, xf?: (p: P3) => P3): Face[] {
  return solid(
    [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
      [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
      [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
    ],
    xf,
  );
}

function prismN(n: number, r: number, z0: number, z1: number, phase = 0): Face[] {
  const ring = Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  });
  const faces: P3[][] = [ring.map(([x, y]) => [x, y, z1] as P3)];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    faces.push([[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]]);
  }
  const sides = solid(faces.slice(1));
  sides.sort((a, b) => depth(a) - depth(b));
  return [...sides, ...solid([faces[0]])];
}

function depth(f: Face) {
  let d = 0;
  for (const p of f.pts) d += p[0] * VIEW[0] + p[1] * VIEW[1] + p[2] * VIEW[2];
  return d / f.pts.length;
}

function openTray(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, t: number, divider: boolean): Face[] {
  return [
    ...cuboid(x0, x1, y1 - t, y1, z0, z1),
    ...cuboid(x0, x0 + t, y0, y1, z0, z1),
    ...cuboid(x0 + t, x1 - t, y0 + t, y1 - t, z0, z0 + t),
    ...(divider ? cuboid(-0.45, 0.45, y0 + t, y1 - t, z0, z1 - 1.5) : []),
    ...cuboid(x1 - t, x1, y0, y1, z0, z1),
    ...cuboid(x0, x1, y0, y0 + t, z0, z1),
  ];
}

function rotXAbout(deg: number, y: number, z: number) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ([px, py, pz]: P3): P3 => [px, y + (py - y) * c - (pz - z) * s, z + (py - y) * s + (pz - z) * c];
}

const ICONS: Record<BoxTypeId, () => Face[]> = {
  tray: () => openTray(-10, 10, -7, 7, 0, 8, 1, true),
  lidded: () => [...cuboid(-10, 10, -7, 7, 0, 8), ...cuboid(-8.6, 8.6, -5.6, 5.6, 9, 11.2), ...cuboid(-10, 10, -7, 7, 11, 14)],
  sliding: () => [...cuboid(-10, 10, -7, 7, 0, 9), ...cuboid(-8.8, 8.8, -15, 6, 9.2, 10.8)],
  hinged: () => [
    ...cuboid(-10, 10, -7, 7, 8, 10.4, rotXAbout(-104, 7.8, 8)),
    ...cuboid(-10, 10, -7, 7, 0, 8),
    ...cuboid(-7, -3, 7, 8.6, 6.6, 9.2),
    ...cuboid(3, 7, 7, 8.6, 6.6, 9.2),
  ],
  drawers: () => [
    ...cuboid(-10, 10, -7, 7, 0, 15.5),
    ...cuboid(-9, 9, -7.4, -7, 10.8, 14.6),
    ...cuboid(-2, 2, -8.4, -7.4, 12.4, 13.6),
    ...cuboid(-9, 9, -7.4, -7, 0.9, 4.7),
    ...cuboid(-2, 2, -8.4, -7.4, 2.4, 3.6),
    ...openTray(-9, 9, -16, -4, 5.7, 9.9, 0.8, false),
    ...cuboid(-2, 2, -17, -16, 7.4, 8.6),
  ],
  polygon: () => [...prismN(6, 10, 0, 8, Math.PI / 6), ...prismN(6, 10, 10.5, 13.5, Math.PI / 6)],
  jar: () => [...prismN(28, 8.4, 0, 11.5), ...prismN(28, 8.6, 13, 17.5)],
  gridfinity: () => [...cuboid(-9.6, -0.6, -4.6, 4.6, 0, 2.6), ...cuboid(0.6, 9.6, -4.6, 4.6, 0, 2.6), ...openTray(-10, 10, -5, 5, 2.6, 12, 0.9, true)],
};

export function IsoIcon({ type }: { type: BoxTypeId }) {
  const faces = ICONS[type]();
  const pts2 = faces.flatMap((f) => f.pts.map(proj));
  const xs = pts2.map((p) => p[0]), ys = pts2.map((p) => p[1]);
  const minX = Math.min(...xs) - 1.5, maxX = Math.max(...xs) + 1.5, minY = Math.min(...ys) - 1.5, maxY = Math.max(...ys) + 1.5;
  return (
    <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      {faces.map((f, i) => (
        <polygon key={i} className={`${f.cls} iso-stroke`} points={f.pts.map(proj).map((p) => p.join(',')).join(' ')} />
      ))}
    </svg>
  );
}
