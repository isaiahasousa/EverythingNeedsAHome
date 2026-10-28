import { useEffect, useState } from 'react';
import { warmUpSaving } from './export/save';
import { startBuilds, useFaces } from './state/buildController';
import { blankProject, normalizeProject } from './state/project';
import { historyStore, projectStore, redo, replaceProject, setUI, toast, uiStore, undo, update, useProject, useUI, type Step, type UIState } from './state/store';
import { useSyncExternalStore } from 'react';
import { Segmented } from './ui/controls';
import { FaceEditor } from './ui/FaceEditor';
import { Icon } from './ui/icons';
import { DetailsStep, SizeStep, TypeStep } from './ui/steps/BasicSteps';
import { ExportStep } from './ui/steps/ExportStep';
import { addFiles, GraphicsStep } from './ui/steps/GraphicsStep';
import { ViewerPanel } from './viewer/ViewerPanel';

const STEPS: { id: Step; label: string }[] = [
  { id: 'type', label: 'Box' },
  { id: 'size', label: 'Size' },
  { id: 'details', label: 'Details' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'export', label: 'Print' },
];

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 26 26" aria-hidden="true">
      <path d="M13 2.5 23 8v10.5L13 24 3 18.5V8Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M3 8 13 13.5 23 8 13 2.5Z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13 13.5V24" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M6.5 13.2 9.5 14.9M6.5 16.4 9.5 18.1" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function StepBody({ step }: { step: Step }) {
  switch (step) {
    case 'type':
      return <TypeStep />;
    case 'size':
      return <SizeStep />;
    case 'details':
      return <DetailsStep />;
    case 'graphics':
      return <GraphicsStep />;
    case 'export':
      return <ExportStep />;
  }
}

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function App() {
  const step = useUI((u) => u.step);
  const faceId = useUI((u) => u.faceId);
  const mobilePane = useUI((u) => u.mobilePane);
  const toastState = useUI((u) => u.toast);
  const name = useProject((p) => p.name);
  const graphics = useProject((p) => p.graphics);
  const history = useSyncExternalStore(historyStore.subscribe, historyStore.get);
  const { faces } = useFaces();
  const [dragging, setDragging] = useState(false);
  const face = step === 'graphics' ? faces.find((f) => f.id === faceId) ?? null : null;

  useEffect(() => {
    startBuilds();
    warmUpSaving();
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drop or paste images, SVGs and saved projects anywhere.
  useEffect(() => {
    const targetFace = () => {
      const fs = facesRef.current;
      const ui = setUIRef.current;
      const id = ui ?? fs.find((f) => f.id === 'front')?.id ?? fs[0]?.id;
      return fs.find((f) => f.id === id) ?? fs[0];
    };
    const handleFiles = async (files: File[]) => {
      const json = files.find((f) => /\.json$/i.test(f.name));
      if (json) {
        try {
          replaceProject(normalizeProject(JSON.parse(await json.text())));
          toast(`Opened ${json.name}`);
        } catch (err) {
          toast(String((err as Error).message ?? err), 'error');
        }
        return;
      }
      const imgs = files.filter((f) => f.type.startsWith('image/') || /\.svg$/i.test(f.name));
      const f = targetFace();
      if (!imgs.length || !f) return;
      setUI({ step: 'graphics', faceId: f.id });
      await addFiles(imgs, f);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setDragging(false);
      void handleFiles([...e.dataTransfer.files]);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void handleFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
        e.preventDefault();
        void handleFiles([new File([text], 'pasted.svg', { type: 'image/svg+xml' })]);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, []);
  const facesRef = useLatest(faces);
  const setUIRef = useLatest(faceId);

  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setUI({ toast: null }), toastState.tone === 'ok' ? 3200 : 6000);
    return () => clearTimeout(t);
  }, [toastState]);

  const idx = STEPS.findIndex((s) => s.id === step);
  const go = (s: Step) => {
    const patch: Partial<UIState> = { step: s };
    if (s === 'export') patch.view = 'print';
    else if (uiStore.get().view === 'print') patch.view = 'assembled';
    setUI(patch);
    document.querySelector('.rail-body')?.scrollTo({ top: 0 });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">
            EverythingNeedsA<span className="brand-home">Home</span>
          </span>
        </div>
        <input className="project-name" aria-label="Project name" value={name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }), 'name')} />
        <span className="topbar-spacer" />
        <div className="topbar-actions">
          <button type="button" className="btn ghost icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={undo}>
            <Icon name="undo" />
          </button>
          <button type="button" className="btn ghost icon" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={redo}>
            <Icon name="redo" />
          </button>
          <button
            type="button"
            className="btn ghost hide-narrow"
            title="Start over with an empty box (undo brings this one back)"
            onClick={() => {
              replaceProject(blankProject(projectStore.get().type));
              setUI({ step: 'type' });
              toast('Started a new box. Undo brings back the previous one.');
            }}
          >
            <Icon name="reset" /> New
          </button>
          <button type="button" className="btn primary" onClick={() => go('export')}>
            <Icon name="download" /> <span className="hide-narrow">Download</span>
          </button>
        </div>
      </header>

      <aside className="rail" aria-label="Design steps">
        <nav className="stepper" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s.id} type="button" aria-current={s.id === step ? 'step' : undefined} onClick={() => go(s.id)}>
              <span className="step-n">{String(i + 1).padStart(2, '0')}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="rail-body">
          <StepBody step={step} />
        </div>
        <div className="rail-foot">
          <button type="button" className="btn" disabled={idx === 0} onClick={() => go(STEPS[idx - 1].id)}>
            <Icon name="left" /> Back
          </button>
          {idx < STEPS.length - 1 ? (
            <button type="button" className="btn primary" onClick={() => go(STEPS[idx + 1].id)}>
              Next: {STEPS[idx + 1].label} <Icon name="right" />
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => go('type')}>
              Change the box
            </button>
          )}
        </div>
      </aside>

      <main className={`stage ${face ? 'split' : ''} ${mobilePane === 'face' ? 'mobile-face' : ''}`}>
        <ViewerPanel />
        {face && <FaceEditor face={face} graphics={graphics.filter((g) => g.faceId === face.id)} />}
        {face && (
          <div className="mobile-tabs" style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 5 }}>
            <Segmented
              label="Show"
              value={mobilePane}
              onChange={(v) => setUI({ mobilePane: v })}
              options={[
                { value: '3d', label: '3D' },
                { value: 'face', label: 'Face' },
              ]}
            />
          </div>
        )}
      </main>

      {toastState && (
        <div className={`toast ${toastState.tone === 'error' ? 'error' : ''}`} role="status">
          {toastState.text}
        </div>
      )}
      {dragging && <div className="drop-veil">Drop an image, SVG or project file</div>}
    </div>
  );
}

function useLatest<T>(value: T) {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
