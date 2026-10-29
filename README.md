# EverythingNeedsAHome

A browser app for designing 3D-printable boxes, in the spirit of [MakerCase](https://www.makercase.com) but for
3D printers instead of laser cutters. Pick a box type, set the size, decorate any face with text, images,
shapes or vents, and download print-ready STL or 3MF files.

Everything runs in the browser. There is no backend, account or upload: geometry is built locally in a
Web Worker with [manifold-3d](https://github.com/elalish/manifold), so every exported part is a watertight solid.
Your designs and images never leave your computer. The only outside requests are for the interface fonts,
which come from Google Fonts. The fonts used for text on boxes are bundled with the app.

## Box types

| Type | What you get |
| --- | --- |
| Open tray | Open box with an optional grid of compartments |
| Box with lid | Inset plug, flush step, or slip-over cap lid; optional snap bumps |
| Sliding lid | Dovetail lid that slides in from the front and sits flush; optional thumb grip |
| Hinged box | Knuckle hinge with a 1.75 mm filament pin (or a printed pin), alignment lip, finger notch |
| Drawer cabinet | Sleeve with 1 to 8 drawers, ledge-tab or finger-notch pulls |
| Polygon box | 3 to 12 sides, with any of the lid styles |
| Screw-top jar | Helical 45° threads with run-outs, knurled or smooth cap |
| Gridfinity bin | 42 mm grid feet, stacking lip, magnet holes, label shelf, dividers |

Every part is laid out to print without supports at sensible settings. When a setting would need supports or
weaken a part (knuckles too big for a short hinged box, raised graphics facing the print bed, walls that are
too thin), the app tells you. Clearances (lid fit, drawer gap, thread gap) are adjustable, and the geometry
tests check that mating parts never intersect: the hinge swings 180° clear, the cap unscrews, drawers and
the sliding lid slide out, and Gridfinity bins stack.

## Graphics

Click a face in the 3D view (or pick it from the list) to open the 2D face editor. Drag to move,
use the corner handles to scale and the top handle to rotate (snaps to 15°; hold Alt for free movement).

- **Sources:** text (8 bundled fonts, or your own TTF/OTF/WOFF, which is saved inside the project so the text
  looks the same when you reopen it), PNG/JPG/WebP images (traced to outlines with an
  adjustable threshold), SVG files (fills with their fill rules, strokes outlined), 12 built-in shapes,
  and vent patterns (honeycomb, round, slots, squares, diamonds).
- **Effects:** raised, engraved, cut through, inlay (a pocket plus a matching fill part for a second filament
  colour), and lithophane (photo relief that shows the picture when backlit).
- Graphics wrap around curved surfaces such as the jar body.
- Graphics stack in the order you add them: a later one sits on, or cuts into, the ones before it. Raise a
  name on a raised plate, or inlay white letters on a coloured disc.
- Drop or paste an image anywhere in the app to add it to the current face.

## Exports

- **3MF** with every part laid out on your printer's bed in print orientation, turned 90° when that is how
  they fit. Inlays come in as parts of a single multi-material object, ready for an AMS / MMU.
- **STL** per part, or all parts in a ZIP.
- **Project files** (`.project.json`) to save and reopen designs, including any fonts you uploaded. Work is
  also autosaved in the browser (projects too big for its usual storage, such as ones with large photos,
  are kept in the browser's IndexedDB instead).

When the app runs inside a claude.ai artifact, the host only allows certain download types, so model
files are delivered inside a `.zip`.

## Develop

Requires Node 20.19+ (22 recommended).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # geometry, graphics and fit tests (vitest)
npm run build      # production build in dist/
npm run e2e        # end-to-end check of the build in Chromium (after npm run build)
npm run preview    # serve dist/ locally
```

The full checklist used before a change ships, including the adversarial self-review, is the
testing protocol in [CLAUDE.md](CLAUDE.md). For `npm run e2e` on a new machine, install the browser once
with `npx playwright install chromium`.

The first `dev`/`build` runs `scripts/make-fallback.mjs`, which translates the manifold WebAssembly module
to plain JavaScript (about 15 s, cached in `src/generated/`). The app only loads that file when a page's
security policy blocks WebAssembly; results are identical, just slower.

## Launch it online

`npm run build` produces a fully static site in `dist/` with relative paths, so it works at a domain root
or in a sub-folder. It needs no server code (no PHP, no database).

### Cloudflare (main host)

The repository carries its own Cloudflare settings: `.nvmrc` pins Node 22, and `wrangler.jsonc` tells
Cloudflare to run `npm run build` and serve `dist/`. Either kind of Cloudflare project works.

**As a Worker** (the dashboard's default **Workers & Pages → Create → Import a repository** flow):

1. Pick `isaiahasousa/EverythingNeedsAHome`. Keep the default deploy command, `npx wrangler deploy`.
   Leave the build command empty (`wrangler.jsonc` runs the build).
2. The Worker's name must match `name` in `wrangler.jsonc` (`everythingneedsahome`). If you chose another
   name, change that line to match; otherwise the build stops with a name error.
3. Every push to `main` redeploys. Build settings live under the Worker's **Settings → Build**.

**As a Pages project** (**Workers & Pages → Create → Pages → Connect to Git**):

1. Production branch `main`, framework preset **None**, build command `npm run build`, build output
   directory `dist`. No environment variables are needed (`.nvmrc` sets the Node version).
2. **Save and Deploy.** Every push to `main` redeploys; other branches get preview URLs.

`public/_headers` is copied into the build and sets the response headers: a content security policy
(it allows WebAssembly, the geometry worker and Google Fonts, and nothing else), `nosniff`, a referrer
policy, a permissions policy, and year-long caching for the hashed files in `assets/`. Netlify reads the
same file.

### Other hosts

- **GitHub Pages:** set Settings → Pages → Source to "GitHub Actions", then run the "Deploy to GitHub Pages"
  workflow from the Actions tab (it is manual so it does not fail on pushes while Cloudflare hosts the site).
- **Netlify:** connect the repository (settings come from `netlify.toml`).
- **Vercel:** import the repository; it detects Vite. Build command `npm run build`, output `dist`.
- **Any static host or bucket:** upload the contents of `dist/`. Serve `.wasm` as `application/wasm`
  (most hosts do; if not, the app still works using the slower JavaScript engine).

### Continuous integration

`.github/workflows/ci.yml` runs the testing protocol on every push and pull request: typecheck, unit tests,
build, and the end-to-end browser test.

`npm run build:artifact` additionally writes `dist-artifact/`, the variant used for claude.ai artifact hosting.

## Project layout

```
src/
  boxes/        one file per box type: parameters, faces, part list, warnings and the solid builder
  geometry/     manifold kernel helpers, graphics-to-solid (emboss, deboss, cut, inlay, lithophane), build
  graphics/     2D outlines from text (opentype.js), SVG, traced images, shapes and patterns
  worker/       geometry worker and its client; only the newest request is built
  viewer/       three.js viewer: assembled / apart / print-bed views, face picking and highlights
  ui/           React panels for each step and the 2D face editor
  export/       STL, 3MF and ZIP writers, print-bed layout, saving (including claude.ai downloads)
  state/        project model, undo history, autosave, build controller
tests/          vitest suites (every box type, fit and motion checks, graphics, JS fallback),
                e2e/smoke.mjs browser test, verify-downloads.mjs export checker
```

To add a box type:

1. Create `src/boxes/<name>.ts` exporting a `BoxType` (`tray.ts` is the smallest example).
2. Add its id to `BoxTypeId` and any new parameters to `BoxParams` in `src/core/types.ts`, with defaults in
   `DEFAULT_PARAMS` (`src/boxes/index.ts`).
3. Register it in `BOX_TYPES` and `BOX_ORDER` in `src/boxes/index.ts`. Project files are checked against
   `BOX_ORDER`, so a type missing there opens as an open tray.
4. Draw its icon in `src/ui/icons.tsx`.

`tests/boxes.test.ts` builds every registered type and checks each part is a single watertight solid.

## Credits and licences

- Geometry: [manifold-3d](https://github.com/elalish/manifold) (Apache-2.0)
- 3D view: [three.js](https://threejs.org) (MIT); UI: [React](https://react.dev) (MIT)
- Text outlines: [opentype.js](https://opentype.js.org) (MIT); ZIP/3MF: [fflate](https://github.com/101arrowz/fflate) (MIT)
- Bundled fonts from Google Fonts via Fontsource, under the SIL Open Font License 1.1 or Apache-2.0;
  licence texts are in `public/fonts/licenses/`.
- Gridfinity is an open storage system by Zack Freedman. Dimensions follow the published reference
  (42 mm grid, 7 mm height units).
- Inspired by MakerCase; not affiliated with it.

Choose a licence for your own code before publishing the repository (MIT is a common choice for apps like this).
