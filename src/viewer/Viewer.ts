import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { IDENTITY, mulMat, translation } from '../core/math';
import type { FaceDef, Mat4, PartMesh, Vec3 } from '../core/types';
import type { ViewMode } from '../state/store';

export interface ViewerTheme {
  edge: string;
  accent: string;
  plate: string;
  plateLine: string;
  shadow: string;
}

interface PartView {
  info: PartMesh;
  group: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  from: { p: THREE.Vector3; q: THREE.Quaternion };
  to: { p: THREE.Vector3; q: THREE.Quaternion };
}

const tmpM = new THREE.Matrix4();

function toMatrix4(m: Mat4) {
  return new THREE.Matrix4().fromArray(m);
}

function decompose(m: Mat4) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  toMatrix4(m).decompose(p, q, s);
  return { p, q };
}

/** Rotation by `deg` about `axis` through `pivot`, as a column-major matrix. */
function pivotRotation(axis: Vec3, deg: number, pivot: Vec3): Mat4 {
  const r = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return mulMat(mulMat(translation(pivot[0], pivot[1], pivot[2]), r.toArray()), translation(-pivot[0], -pivot[1], -pivot[2]));
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private parts = new Map<string, PartView>();
  private bodyMat: THREE.MeshStandardMaterial;
  private colorMats = new Map<string, THREE.MeshStandardMaterial>();
  private edgeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.3 });
  private plate = new THREE.Group();
  private shadow: THREE.Mesh;
  private highlight = new THREE.Group();
  private hover = new THREE.Group();
  private theme: ViewerTheme = { edge: '#000', accent: '#c48a2c', plate: '#b8955a', plateLine: '#8d6d3a', shadow: '#000' };
  private view: ViewMode = 'assembled';
  private layout = new Map<string, Mat4>();
  private anim: { start: number; dur: number; cam?: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3 } } | null = null;
  private dirty = true;
  private raf = 0;
  private ro: ResizeObserver;
  private faces: FaceDef[] = [];
  private highlightFace: string | null = null;
  private hoverFace: string | null = null;
  private showEdges = true;
  private bed = { w: 256, d: 256 };
  private reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private hasFitted = false;
  private fitOnResize = false;
  onPick: (faceId: string | null, partId: string | null) => void = () => {};
  onHoverFace: ((faceId: string | null) => void) | null = null;
  pickEnabled = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => (this.dirty = true));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-120, -180, 260);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(200, 160, 120);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x6a7680, 0.55));

    this.bodyMat = new THREE.MeshStandardMaterial({ color: '#2f8a87', roughness: 0.58, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

    // Soft contact shadow under the model in the assembled / exploded views.
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.42)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.shadow.position.z = -0.05;
    this.shadow.renderOrder = -1;

    this.scene.add(this.root, this.plate, this.shadow);
    this.buildPlate();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.bindPointer();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const pv of this.parts.values()) this.disposePart(pv);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------ appearance

  setTheme(theme: ViewerTheme) {
    this.theme = theme;
    this.edgeMat.color.set(theme.edge);
    this.buildPlate();
    this.refreshFaceOverlays();
    this.dirty = true;
  }

  setBodyColor(hex: string) {
    this.bodyMat.color.set(hex);
    this.dirty = true;
  }

  setEdges(on: boolean) {
    this.showEdges = on;
    for (const pv of this.parts.values()) pv.edges.visible = on;
    this.dirty = true;
  }

  private colorMat(hex: string) {
    let m = this.colorMats.get(hex);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      this.colorMats.set(hex, m);
    }
    return m;
  }

  setBed(w: number, d: number) {
    this.bed = { w, d };
    this.buildPlate();
  }

  private buildPlate() {
    for (const ch of [...this.plate.children]) {
      this.plate.remove(ch);
      (ch as THREE.Mesh).geometry?.dispose();
    }
    const { w, d } = this.bed;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w, d, 2),
      new THREE.MeshStandardMaterial({ color: this.theme.plate, roughness: 0.9, metalness: 0.15 }),
    );
    slab.position.z = -1.02;
    const pts: number[] = [];
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += 10) pts.push(x, -d / 2, 0.02, x, d / 2, 0.02);
    for (let y = -d / 2; y <= d / 2 + 1e-6; y += 10) pts.push(-w / 2, y, 0.02, w / 2, y, 0.02);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: this.theme.plateLine, transparent: true, opacity: 0.45 }),
    );
    this.plate.add(slab, grid);
    this.plate.visible = this.view === 'print';
    this.dirty = true;
  }

  // ------------------------------------------------------------ parts

  private disposePart(pv: PartView) {
    pv.mesh.geometry.dispose();
    pv.edges.geometry.dispose();
    this.root.remove(pv.group);
  }

  setParts(parts: PartMesh[], faces: FaceDef[], layout: Map<string, Mat4>) {
    const old = new Map(this.parts);
    this.parts.clear();
    this.faces = faces;
    this.layout = layout;
    for (const info of parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(info.renderPositions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(info.renderNormals, 3));
      for (const g of info.groups) geo.addGroup(g.start, g.count, g.materialIndex);
      geo.computeBoundingSphere();
      const mats = info.materials.map((c) => (c === null ? this.bodyMat : this.colorMat(c)));
      const mesh = new THREE.Mesh(geo, mats);
      mesh.userData.partId = info.id;
      const edges = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(info.edges, 3)), this.edgeMat);
      edges.visible = this.showEdges;
      edges.raycast = () => {};
      const group = new THREE.Group();
      group.add(mesh, edges);
      group.matrixAutoUpdate = true;
      const prevView = old.get(info.id) ?? (info.parentId ? old.get(info.parentId) : undefined);
      const target = this.targetFor(info);
      const start = prevView ? { p: prevView.group.position.clone(), q: prevView.group.quaternion.clone() } : target;
      group.position.copy(start.p);
      group.quaternion.copy(start.q);
      this.root.add(group);
      this.parts.set(info.id, { info, group, mesh, edges, from: start, to: target });
    }
    for (const pv of old.values()) this.disposePart(pv);
    this.refreshFaceOverlays();
    this.updateShadow();
    if (!this.hasFitted && parts.length) {
      this.hasFitted = true;
      this.fit(false);
    }
    this.startAnim(false);
  }

  private targetFor(info: PartMesh) {
    let m: Mat4 = IDENTITY;
    if (this.view === 'exploded') {
      m = translation(info.explode[0], info.explode[1], info.explode[2]);
      if (info.open) m = mulMat(m, pivotRotation(info.open.axis, info.open.angle, info.open.pivot));
    } else if (this.view === 'print') {
      m = this.layout.get(info.id) ?? info.print;
    }
    return decompose(m);
  }

  setLayout(layout: Map<string, Mat4>) {
    this.layout = layout;
    if (this.view === 'print') this.retarget(true);
  }

  setView(view: ViewMode) {
    if (view === this.view) return;
    this.view = view;
    this.plate.visible = view === 'print';
    this.retarget(true);
  }

  private retarget(fitCamera: boolean) {
    for (const pv of this.parts.values()) {
      pv.from = { p: pv.group.position.clone(), q: pv.group.quaternion.clone() };
      pv.to = this.targetFor(pv.info);
    }
    this.startAnim(fitCamera);
  }

  private startAnim(fitCamera: boolean) {
    const dur = this.reduceMotion ? 1 : 520;
    this.anim = { start: performance.now(), dur };
    if (fitCamera) {
      const box = this.targetBounds();
      if (!box.isEmpty()) {
        const { pos, target } = this.framing(box);
        this.anim.cam = { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target };
      }
    }
    this.dirty = true;
  }

  private targetBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const pv of this.parts.values()) {
      const geo = pv.mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const b = geo.boundingBox!.clone().applyMatrix4(tmpM.compose(pv.to.p, pv.to.q, new THREE.Vector3(1, 1, 1)));
      box.union(b);
    }
    if (this.view === 'print') {
      box.expandByPoint(new THREE.Vector3(-this.bed.w / 2, -this.bed.d / 2, 0));
      box.expandByPoint(new THREE.Vector3(this.bed.w / 2, this.bed.d / 2, 0));
    }
    return box;
  }

  private framing(box: THREE.Box3) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(10, size.length() / 2);
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.4, this.camera.aspect);
    const dist = (radius / Math.sin(fov / 2)) * (aspect < 1 ? 1 / aspect : 1) * 0.92;
    const dir = this.view === 'print' ? new THREE.Vector3(0.35, -1, 0.95) : new THREE.Vector3(0.72, -1.15, 0.78);
    dir.normalize();
    return { pos: center.clone().addScaledVector(dir, dist), target: center };
  }

  fit(animate = true) {
    const box = this.targetBounds();
    if (box.isEmpty()) return;
    const { pos, target } = this.framing(box);
    if (!animate || this.reduceMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.dirty = true;
      return;
    }
    this.anim = { start: performance.now(), dur: 450, cam: { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target } };
    for (const pv of this.parts.values()) pv.from = { p: pv.group.position.clone(), q: pv.group.quaternion.clone() };
  }

  /** Swing the camera to look straight at a face. */
  lookAtFace(faceId: string) {
    const f = this.faces.find((x) => x.id === faceId);
    const pv = f && this.parts.get(f.partId);
    if (!f || !pv) return;
    const m = tmpM.compose(pv.group.position, pv.group.quaternion, new THREE.Vector3(1, 1, 1));
    let n = new THREE.Vector3(...f.n);
    let o = new THREE.Vector3(...f.origin);
    if (f.kind === 'cylinder') {
      const a = f.angle0 ?? -Math.PI / 2;
      n = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      o = new THREE.Vector3(f.origin[0] + n.x * (f.radius ?? 0), f.origin[1] + n.y * (f.radius ?? 0), f.origin[2]);
    }
    o.applyMatrix4(m);
    n.transformDirection(m);
    const span = Math.max(f.kind === 'cylinder' ? (f.radius ?? 20) * 2 : f.width, f.height, 30);
    const dist = (span / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.5;
    const tilt = Math.abs(n.z) > 0.9 ? new THREE.Vector3(0, -0.35, 0) : new THREE.Vector3(0, 0, 0.18);
    const pos = o.clone().addScaledVector(n.clone().add(tilt).normalize(), dist);
    this.anim = { start: performance.now(), dur: this.reduceMotion ? 1 : 480, cam: { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: o } };
    for (const pv2 of this.parts.values()) pv2.from = { p: pv2.group.position.clone(), q: pv2.group.quaternion.clone() };
  }

  private updateShadow() {
    const box = new THREE.Box3();
    for (const pv of this.parts.values()) {
      const geo = pv.mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      box.union(geo.boundingBox!);
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    this.shadow.scale.set(size.x * 1.7 + 20, size.y * 1.7 + 20, 1);
    this.shadow.position.set(c.x, c.y, -0.05);
  }

  // ------------------------------------------------------------ faces

  setFaces(faces: FaceDef[]) {
    this.faces = faces;
    this.refreshFaceOverlays();
  }

  setHighlight(faceId: string | null) {
    this.highlightFace = faceId;
    this.refreshFaceOverlays();
  }

  private setHover(faceId: string | null) {
    if (faceId === this.hoverFace) return;
    this.hoverFace = faceId;
    this.onHoverFace?.(faceId);
    this.refreshFaceOverlays();
  }

  private refreshFaceOverlays() {
    for (const grp of [this.highlight, this.hover]) {
      grp.parent?.remove(grp);
      for (const ch of [...grp.children]) {
        grp.remove(ch);
        (ch as THREE.Mesh).geometry?.dispose();
      }
    }
    const add = (grp: THREE.Group, faceId: string | null, strong: boolean) => {
      const f = faceId ? this.faces.find((x) => x.id === faceId) : null;
      const pv = f && this.parts.get(f.partId);
      if (!f || !pv) return;
      const pts = faceOutline3D(f, 0.12);
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: this.theme.accent, transparent: true, opacity: strong ? 1 : 0.6, depthTest: true }),
      );
      grp.add(line);
      if (f.kind === 'plane' && f.outline.length >= 3) {
        const shape = new THREE.Shape(f.outline.map(([x, y]) => new THREE.Vector2(x, y)));
        const geo = new THREE.ShapeGeometry(shape);
        geo.applyMatrix4(new THREE.Matrix4().fromArray(faceMatrix(f, 0.1)));
        grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: strong ? 0.16 : 0.08, depthWrite: false, side: THREE.DoubleSide })));
      }
      pv.group.add(grp);
    };
    add(this.highlight, this.highlightFace, true);
    if (this.hoverFace && this.hoverFace !== this.highlightFace) add(this.hover, this.hoverFace, false);
    this.dirty = true;
  }

  // ------------------------------------------------------------ picking

  private bindPointer() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const pick = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const meshes = [...this.parts.values()].map((p) => p.mesh);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit || !hit.face) return { faceId: null, partId: null };
      const mesh = hit.object as THREE.Mesh;
      const pv = this.parts.get(mesh.userData.partId);
      if (!pv) return { faceId: null, partId: null };
      const partId = pv.info.role === 'inlay' ? pv.info.parentId ?? pv.info.id : pv.info.id;
      const local = pv.group.worldToLocal(hit.point.clone());
      return { faceId: matchFace(this.faces, partId, local, hit.face.normal), partId };
    };
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5 || e.button !== 0) return;
      const r = pick(e);
      this.onPick(r.faceId, r.partId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pickEnabled || e.buttons) return;
      this.setHover(pick(e).faceId);
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
  }

  // ------------------------------------------------------------ loop

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    const before = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    if (this.fitOnResize && Math.abs(before - this.camera.aspect) > 0.05) {
      this.fitOnResize = false;
      this.fit();
    }
  }

  /** Re-frame the model after the next layout change (e.g. the face editor opening beside it). */
  refitAfterResize() {
    this.fitOnResize = true;
    setTimeout(() => {
      if (this.fitOnResize) {
        this.fitOnResize = false;
        this.fit();
      }
    }, 400);
  }

  requestRender() {
    this.dirty = true;
  }

  private tick(now: number) {
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.start) / this.anim.dur);
      const k = ease(t);
      for (const pv of this.parts.values()) {
        pv.group.position.lerpVectors(pv.from.p, pv.to.p, k);
        pv.group.quaternion.slerpQuaternions(pv.from.q, pv.to.q, k);
      }
      if (this.anim.cam) {
        this.camera.position.lerpVectors(this.anim.cam.p0, this.anim.cam.p1, k);
        this.controls.target.lerpVectors(this.anim.cam.t0, this.anim.cam.t1, k);
      }
      this.shadow.visible = this.view !== 'print';
      if (t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** PNG snapshot of the current view (used for the gallery thumbnail in project files). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/** Matrix taking face coordinates (x right, y up, z out) to part coordinates (planar faces). */
export function faceMatrix(f: FaceDef, lift = 0): Mat4 {
  const [ox, oy, oz] = f.origin;
  return [f.u[0], f.u[1], f.u[2], 0, f.v[0], f.v[1], f.v[2], 0, f.n[0], f.n[1], f.n[2], 0, ox + f.n[0] * lift, oy + f.n[1] * lift, oz + f.n[2] * lift, 1];
}

export function facePoint(f: FaceDef, x: number, y: number, lift = 0): THREE.Vector3 {
  if (f.kind === 'cylinder') {
    const R = f.radius ?? 1;
    const a = (f.angle0 ?? -Math.PI / 2) + x / R;
    return new THREE.Vector3(f.origin[0] + (R + lift) * Math.cos(a), f.origin[1] + (R + lift) * Math.sin(a), f.origin[2] + y);
  }
  return new THREE.Vector3(
    f.origin[0] + f.u[0] * x + f.v[0] * y + f.n[0] * lift,
    f.origin[1] + f.u[1] * x + f.v[1] * y + f.n[1] * lift,
    f.origin[2] + f.u[2] * x + f.v[2] * y + f.n[2] * lift,
  );
}

function faceOutline3D(f: FaceDef, lift: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ring = f.outline.length >= 3 ? f.outline : [[-f.width / 2, -f.height / 2], [f.width / 2, -f.height / 2], [f.width / 2, f.height / 2], [-f.width / 2, f.height / 2]];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const steps = f.kind === 'cylinder' ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2)) : 1;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push(facePoint(f, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, lift));
    }
  }
  return out;
}

function matchFace(faces: FaceDef[], partId: string, p: THREE.Vector3, normal: THREE.Vector3): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const f of faces) {
    if (f.partId !== partId) continue;
    if (f.kind === 'plane') {
      const n = new THREE.Vector3(...f.n);
      const d = p.clone().sub(new THREE.Vector3(...f.origin));
      const h = d.dot(n);
      if (h < -1.5 || h > 5) continue;
      if (normal.dot(n) < 0.6 && Math.abs(h) > 0.05) continue;
      const x = d.dot(new THREE.Vector3(...f.u));
      const y = d.dot(new THREE.Vector3(...f.v));
      if (Math.abs(x) > f.width / 2 + 1.5 || Math.abs(y) > f.height / 2 + 1.5) continue;
      const score = Math.abs(h) + (normal.dot(n) < 0.6 ? 2 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = f.id;
      }
    } else {
      const R = f.radius ?? 0;
      const r = Math.hypot(p.x - f.origin[0], p.y - f.origin[1]);
      if (Math.abs(r - R) > 5) continue;
      if (Math.abs(p.z - f.origin[2]) > f.height / 2 + 1.5) continue;
      const radial = new THREE.Vector3(p.x - f.origin[0], p.y - f.origin[1], 0).normalize();
      if (normal.dot(radial) < 0.3) continue;
      const score = Math.abs(r - R);
      if (score < bestScore) {
        bestScore = score;
        best = f.id;
      }
    }
  }
  return best;
}
