import type { BoxParams, BoxTypeId } from '../core/types';
import type { BoxType } from './common';
import { drawers } from './drawers';
import { gridfinity } from './gridfinity';
import { hinged } from './hinged';
import { jar } from './jar';
import { lidded } from './lidded';
import { polygon } from './polygon';
import { sliding } from './sliding';
import { tray } from './tray';

export type { BoxType } from './common';

export const BOX_TYPES: Record<BoxTypeId, BoxType> = { tray, lidded, sliding, hinged, drawers, polygon, jar, gridfinity };
export const BOX_ORDER: BoxTypeId[] = ['tray', 'lidded', 'sliding', 'hinged', 'drawers', 'polygon', 'jar', 'gridfinity'];

export const DEFAULT_PARAMS: BoxParams = {
  width: 90,
  depth: 64,
  height: 48,
  dimsMode: 'outer',
  wall: 2,
  floor: 1.6,
  radius: 4,
  tolerance: 0.25,
  dividersX: 1,
  dividersY: 1,
  dividerThickness: 1.6,
  dividerHeight: 100,
  lidStyle: 'plug',
  lidHeight: 12,
  lidTop: 2,
  lipHeight: 6,
  lipThickness: 1.6,
  snap: false,
  slideLid: 2.4,
  grooveDepth: 1,
  thumbGrip: true,
  knuckles: 5,
  knuckleDiameter: 7,
  pinDiameter: 2,
  hingeGap: 0.4,
  hingeSpan: 70,
  alignLip: true,
  frontNotch: true,
  printedPin: false,
  drawerCount: 3,
  drawerWall: 1.6,
  drawerFloor: 1.2,
  drawerPull: 'tab',
  closedBack: true,
  drawerClearance: 0.35,
  sides: 6,
  diameter: 80,
  polyLid: true,
  polyRound: 1.5,
  threadPitch: 3,
  threadDepth: 1.2,
  threadLength: 10,
  threadClearance: 0.4,
  grip: 'knurl',
  gfX: 2,
  gfY: 1,
  gfZ: 4,
  gfLip: true,
  gfMagnets: false,
  gfWall: 1.2,
  gfDividersX: 2,
  gfDividersY: 1,
  gfLabel: true,
};

/** The widest allowed range of each numeric parameter across the box types, and each select's options. */
const LIMITS = new Map<string, { min: number; max: number; int: boolean }>();
const OPTIONS = new Map<string, Set<string>>([['dimsMode', new Set(['outer', 'inner'])]]);
for (const t of Object.values(BOX_TYPES))
  for (const d of [...t.dims, ...t.groups.flatMap((g) => g.params)]) {
    if (d.kind === 'select') OPTIONS.set(d.key, new Set([...(OPTIONS.get(d.key) ?? []), ...d.options.map((o) => o.value)]));
    else if (d.kind !== 'toggle') {
      const L = LIMITS.get(d.key);
      LIMITS.set(d.key, { min: Math.min(L?.min ?? Infinity, d.min), max: Math.max(L?.max ?? -Infinity, d.max), int: d.kind === 'int' });
    }
  }

/**
 * Fill in any keys missing from an older saved project, and bring every value back inside the range
 * its field allows: a hand-edited or damaged file must not hang the geometry engine.
 */
export function normalizeParams(p: Partial<BoxParams> | undefined): BoxParams {
  const out = { ...DEFAULT_PARAMS } as Record<string, unknown>;
  if (p)
    for (const [k, v] of Object.entries(p)) {
      if (!(k in out) || typeof v !== typeof out[k]) continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        const L = LIMITS.get(k);
        out[k] = L ? Math.min(L.max, Math.max(L.min, L.int ? Math.round(v) : v)) : v;
      } else if (typeof v === 'string') {
        if (OPTIONS.get(k)?.has(v) ?? true) out[k] = v;
      } else out[k] = v;
    }
  return out as unknown as BoxParams;
}
