# EverythingNeedsAHome

Browser app for designing 3D-printable boxes (MakerCase-style, for 3D printers). Vite + React + TypeScript,
three.js for the view, manifold-3d (WebAssembly, with a generated pure-JS fallback) for solid geometry in a
Web Worker. See README.md for features, layout and deployment.

## Conventions

- Units are millimetres internally; Z is up; the front of a box faces -Y.
- Every box type lives in `src/boxes/<type>.ts` and must print without supports.
- Geometry objects from manifold must be created inside a build so `releaseAll()` frees them.
- Store selectors passed to `useProject` / `useUI` / `useBuild` must return stable references
  (no `filter`/`map` inside a selector; derive with `useMemo`), or React re-renders forever.

## Testing protocol

Run these before calling any change done:

1. `npm run typecheck` passes.
2. `npm test` passes: geometry for every box type, fit and motion checks (hinge swing, cap unscrewing,
   drawers and sliding lid, Gridfinity stacking), graphics, WASM-vs-JS engine equivalence, and
   `tests/regressions.test.ts`, which keeps every problem found in review from coming back.
3. `npm run build` succeeds.
4. `npm run e2e` passes: drives the built app in Chromium through every box type, the graphics flow
   (text, PNG, SVG, lithophane, dragging, picking faces in 3D), all downloads (and that they switch off
   while a change is rebuilding), undo/redo, units, error messages, autosave (including projects too big
   for localStorage, and uploaded fonts after a reload), phone width and dark theme. It re-imports every
   downloaded mesh and fails unless each one is watertight and sits on the bed.
5. When the change affects the claude.ai artifact build, run `npm run build:artifact` and check the page
   under a strict content security policy, with and without WebAssembly allowed.
6. **Self-check = adversarial sub-agent review of completed work. Loop until pass.**
   Once the work is complete and steps 1-5 pass, start an independent sub-agent whose only job is to break
   it: read the changes and the code they touch, rerun the checks, try edge cases and odd inputs, and look
   for printability and fit errors, geometry that is not watertight, UI regressions, data loss, and claims
   in the docs that the code does not back up. It reports each finding with evidence and a severity, and
   ends with PASS or FAIL. Fix every confirmed finding (or record why it is not a problem), then start a
   fresh review. Repeat until a review passes. Report the final verdict and what was fixed along the way.
