import { BOX_ORDER, BOX_TYPES } from '../../boxes';
import type { BoxTypeId, Warning } from '../../core/types';
import { FILAMENTS } from '../../state/project';
import { useFaces } from '../../state/buildController';
import { setUI, update, useProject } from '../../state/store';
import { Segmented, Swatches } from '../controls';
import { IsoIcon } from '../icons';
import { ParamField } from '../ParamField';

export function fmtLen(mm: number, units: 'mm' | 'in') {
  return units === 'in' ? (mm / 25.4).toFixed(2) : (Math.round(mm * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

export function Notes({ items }: { items: Warning[] }) {
  if (!items.length) return null;
  return (
    <ul className="notes">
      {items.map((w, i) => (
        <li key={i} className={`note ${w.level}`}>
          {w.text}
        </li>
      ))}
    </ul>
  );
}

export function TypeStep() {
  const type = useProject((p) => p.type);
  const pick = (id: BoxTypeId) => {
    update((p) => (p.type === id ? p : { ...p, type: id }));
    setUI({ faceId: null, selected: null });
  };
  return (
    <>
      <h2 className="step-title">Pick a box</h2>
      <p className="step-lede">Every design prints without supports. You can switch at any time; sizes and graphics carry over.</p>
      <div className="type-grid">
        {BOX_ORDER.map((id) => (
          <button key={id} type="button" className="type-card" aria-pressed={type === id} onClick={() => pick(id)}>
            <IsoIcon type={id} />
            <strong>{BOX_TYPES[id].name}</strong>
            <span>{BOX_TYPES[id].tagline}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function SizeStep() {
  const type = useProject((p) => p.type);
  const units = useProject((p) => p.units);
  const mode = useProject((p) => p.params.dimsMode);
  const { resolved, warnings } = useFaces();
  const t = BOX_TYPES[type];
  const [ow, od, oh] = resolved.outer;
  const [iw, id, ih] = resolved.inner;
  const u = units === 'in' ? 'in' : 'mm';
  return (
    <>
      <h2 className="step-title">Size</h2>
      <div className="section">
        <Segmented
          label="Units"
          value={units}
          onChange={(v) => update((p) => ({ ...p, units: v }))}
          options={[
            { value: 'mm', label: 'Millimetres' },
            { value: 'in', label: 'Inches' },
          ]}
        />
        {t.usesDimsMode && (
          <Segmented
            label="Measure"
            value={mode}
            onChange={(v) => update((p) => ({ ...p, params: { ...p.params, dimsMode: v } }))}
            options={[
              { value: 'outer', label: 'Outside size', title: 'The numbers are the outside of the box' },
              { value: 'inner', label: 'Inside size', title: 'The numbers are the usable space inside' },
            ]}
          />
        )}
      </div>
      <div className="fields">
        {t.dims.map((d) => (
          <ParamField key={d.key} def={d} />
        ))}
      </div>
      <dl className="readout" aria-label="Resulting size">
        <dt>Outside</dt>
        <dd>
          {fmtLen(ow, units)} × {fmtLen(od, units)} × {fmtLen(oh, units)} {u}
        </dd>
        <dt>Inside</dt>
        <dd>
          {fmtLen(Math.max(0, iw), units)} × {fmtLen(Math.max(0, id), units)} × {fmtLen(Math.max(0, ih), units)} {u}
        </dd>
        {type === 'gridfinity' && (
          <>
            <dt>Grid</dt>
            <dd>
              {resolved.nx as number} × {resolved.ny as number} cells, {resolved.nz as number}u
            </dd>
          </>
        )}
      </dl>
      <Notes items={warnings} />
    </>
  );
}

export function DetailsStep() {
  const type = useProject((p) => p.type);
  const color = useProject((p) => p.color);
  const { warnings } = useFaces();
  const t = BOX_TYPES[type];
  return (
    <>
      <h2 className="step-title">{t.name} details</h2>
      {t.groups.map((g) => (
        <section key={g.title} className="section">
          <h3 className="section-title">{g.title}</h3>
          <div className="fields">
            {g.params.map((d) => (
              <ParamField key={d.key} def={d} />
            ))}
          </div>
        </section>
      ))}
      <section className="section">
        <h3 className="section-title">Filament colour</h3>
        <Swatches label="Filament colour" value={color} colors={FILAMENTS} onChange={(hex) => update((p) => ({ ...p, color: hex }), 'color')} />
      </section>
      <Notes items={warnings} />
    </>
  );
}
