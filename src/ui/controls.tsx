import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Evaluate + - * / and parentheses, e.g. "80+4", "3 1/2" (mixed fraction) or "(90-4)/2". */
export function evalExpr(input: string): number | null {
  const src = input.trim().replace(/,/g, '.').replace(/(\d+(?:\.\d+)?)\s+(\d+\/\d+)/g, '($1+$2)');
  if (!src) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };
  const num = (): number | null => {
    skip();
    if (peek() === '(') {
      i++;
      const v = expr();
      skip();
      if (peek() !== ')') return null;
      i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      const v = num();
      return v === null ? null : -v;
    }
    const m = /^\d*\.?\d+(e[-+]?\d+)?/i.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number | null => {
    let v = num();
    for (;;) {
      skip();
      const op = peek();
      if (v === null || (op !== '*' && op !== '/')) return v;
      i++;
      const r = num();
      if (r === null) return null;
      v = op === '*' ? v * r : r === 0 ? null : v / r;
    }
  };
  const expr = (): number | null => {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (v === null || (op !== '+' && op !== '-')) return v;
      i++;
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
  };
  const v = expr();
  skip();
  return v !== null && i === src.length && isFinite(v) ? v : null;
}

const trim = (v: number, decimals: number) => {
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

interface NumberFieldProps {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Step in display units. */
  step?: number;
  unit?: string;
  /** Display value = stored value / scale (25.4 shows millimetres as inches). */
  scale?: number;
  decimals?: number;
  help?: string;
  id?: string;
  integer?: boolean;
  className?: string;
}

export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, unit, scale = 1, decimals = 2, help, id, integer, className }: NumberFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = trim(value / scale, decimals);
  const clampV = (v: number) => {
    let x = Math.min(max, Math.max(min, v));
    if (integer) x = Math.round(x);
    return x;
  };
  const commit = (text: string) => {
    setDraft(null);
    // Leaving a field without typing must not store the rounded display value (e.g. 3 decimals in inches).
    if (text.trim() === shown) return;
    const v = evalExpr(text);
    if (v === null) return;
    const next = clampV(v * scale);
    if (Math.abs(next - value) > 1e-9) onChange(next);
  };
  const nudge = (dir: number, mult = 1) => onChange(clampV(+(value + dir * step * scale * mult).toFixed(6)));

  // Drag the label sideways to scrub the value.
  const scrub = useRef<{ x: number; v: number } | null>(null);
  const onLabelDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    scrub.current = { x: e.clientX, v: value };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onLabelMove = (e: React.PointerEvent) => {
    if (!scrub.current) return;
    const dx = e.clientX - scrub.current.x;
    if (Math.abs(dx) < 2) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const raw = scrub.current.v + Math.round(dx / 4) * step * scale * mult;
    const next = clampV(+raw.toFixed(6));
    if (next !== value) onChange(next);
  };
  const onLabelUp = () => {
    scrub.current = null;
  };

  return (
    <div className={`field ${className ?? ''}`}>
      <label className="field-label" htmlFor={inputId} onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp} onPointerCancel={onLabelUp} title="Drag sideways to adjust">
        {label}
      </label>
      <div className="num-input">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={draft ?? shown}
          onFocus={(e) => {
            setDraft(shown);
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              setDraft(null);
              nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
        <span className="stepbtns">
          <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => nudge(1)}>
            ▲
          </button>
          <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => nudge(-1)}>
            ▼
          </button>
        </span>
      </div>
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, help, id }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; help?: string; id?: string }) {
  const autoId = useId();
  return (
    <div>
      <label className="toggle" htmlFor={id ?? autoId}>
        <span>{label}</span>
        <input id={id ?? autoId} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </label>
      {help && <div className="field-help" style={{ marginTop: 4 }}>{help}</div>}
    </div>
  );
}

export function Select<T extends string>({ label, value, options, onChange, help, id, stacked }: { label: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; help?: string; id?: string; stacked?: boolean }) {
  const autoId = useId();
  return (
    <div className={stacked ? 'field stacked' : 'field'}>
      <label className="field-label static" htmlFor={id ?? autoId}>
        {label}
      </label>
      <select id={id ?? autoId} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, format, id }: { label: ReactNode; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; id?: string }) {
  const autoId = useId();
  return (
    <div>
      <label className="field-label static" htmlFor={id ?? autoId} style={{ display: 'block', marginBottom: 2 }}>
        {label}
      </label>
      <div className="slider-row">
        <input id={id ?? autoId} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="mono" style={{ fontSize: 11.5, textAlign: 'right' }}>
          {format ? format(value) : value}
        </span>
      </div>
    </div>
  );
}

export function Swatches({ value, colors, onChange, label }: { value: string; colors: { name: string; hex: string }[]; onChange: (hex: string) => void; label: string }) {
  const known = colors.some((c) => c.hex.toLowerCase() === value.toLowerCase());
  return (
    <div className="swatches" role="group" aria-label={label}>
      {colors.map((c) => (
        <button key={c.hex} type="button" className="swatch" style={{ background: c.hex }} title={c.name} aria-label={c.name} aria-pressed={c.hex.toLowerCase() === value.toLowerCase()} onClick={() => onChange(c.hex)} />
      ))}
      <label className="swatch custom" title="Custom colour" aria-pressed={!known}>
        <span className="sr-only">Custom colour</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

/** Fires `fn` after `ms` without changes. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
