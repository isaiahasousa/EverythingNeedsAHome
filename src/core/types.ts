// Shared types for the box model, faces, graphics and build results.
// Everything here is plain data so it can cross the worker boundary.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** 4x4 affine matrix, column-major (three.js `elements` / manifold `Mat4` layout). */
export type Mat4 = number[];

export type BoxTypeId =
  | 'tray'
  | 'lidded'
  | 'sliding'
  | 'hinged'
  | 'drawers'
  | 'polygon'
  | 'jar'
  | 'gridfinity';

export type DimsMode = 'outer' | 'inner';
export type LidStyle = 'plug' | 'rabbet' | 'cap';
export type DrawerPull = 'tab' | 'notch' | 'none';
export type GripStyle = 'knurl' | 'smooth';

/** Every parameter for every box type, in one flat record so switching types keeps shared values. */
export interface BoxParams {
  // shared
  width: number;
  depth: number;
  height: number;
  dimsMode: DimsMode;
  wall: number;
  floor: number;
  radius: number;
  tolerance: number;
  // tray
  dividersX: number;
  dividersY: number;
  dividerThickness: number;
  dividerHeight: number; // percent of inner height
  // lids (lidded, polygon, hinged)
  lidStyle: LidStyle;
  lidHeight: number;
  lidTop: number;
  lipHeight: number;
  lipThickness: number;
  snap: boolean;
  // sliding
  slideLid: number;
  grooveDepth: number;
  thumbGrip: boolean;
  // hinged
  knuckles: number;
  knuckleDiameter: number;
  pinDiameter: number;
  hingeGap: number;
  hingeSpan: number; // percent of width
  alignLip: boolean;
  frontNotch: boolean;
  printedPin: boolean;
  // drawers
  drawerCount: number;
  drawerWall: number;
  drawerFloor: number;
  drawerPull: DrawerPull;
  closedBack: boolean;
  drawerClearance: number;
  // polygon + jar
  sides: number;
  diameter: number;
  polyLid: boolean;
  polyRound: number;
  // jar
  threadPitch: number;
  threadDepth: number;
  threadLength: number;
  threadClearance: number;
  grip: GripStyle;
  // gridfinity
  gfX: number;
  gfY: number;
  gfZ: number;
  gfLip: boolean;
  gfMagnets: boolean;
  gfWall: number;
  gfDividersX: number;
  gfDividersY: number;
  gfLabel: boolean;
}

export type ParamKey = keyof BoxParams;

export type ParamDef =
  | { kind: 'length'; key: ParamKey; label: string; min: number; max: number; step?: number; help?: string }
  | { kind: 'number'; key: ParamKey; label: string; min: number; max: number; step: number; unit?: string; help?: string }
  | { kind: 'int'; key: ParamKey; label: string; min: number; max: number; help?: string }
  | { kind: 'select'; key: ParamKey; label: string; options: { value: string; label: string }[]; help?: string }
  | { kind: 'toggle'; key: ParamKey; label: string; help?: string };

export interface ParamGroup {
  title: string;
  params: ParamDef[];
}

/** A surface that graphics can be placed on. All positions are in the assembled pose (mm, Z up). */
export interface FaceDef {
  id: string;
  label: string;
  partId: string;
  kind: 'plane' | 'cylinder';
  /** plane: centre of the face on the outer surface. cylinder: point on the axis at the face's vertical centre. */
  origin: Vec3;
  /** plane: right / up / outward unit vectors as seen from outside. */
  u: Vec3;
  v: Vec3;
  n: Vec3;
  /** cylinder: outer radius and the angle (radians) of the u = 0 meridian. Axis is +Z. */
  radius?: number;
  angle0?: number;
  /** Size of the usable region (unwrapped for cylinders). */
  width: number;
  height: number;
  /** Clip / display outline in face coordinates (origin at the face centre, v up), counter-clockwise. */
  outline: Vec2[];
  /** Wall thickness behind the face, used for cut-through and depth warnings. */
  thickness: number;
  /** True when this face rests on the print bed in the part's print orientation. */
  onBed?: boolean;
  /** True when the part is solid behind the face (thicker than `thickness` in places), so nothing can cut through it. */
  solid?: boolean;
  /** Raised graphics taller than `max` mm break something (a fit, stacking); `why` finishes the warning. */
  raiseLimit?: { max: number; why: string };
}

export interface PartInfo {
  id: string;
  name: string;
  /** Rotation that takes the assembled pose to the print orientation (translation is added by layout). */
  print: Mat4;
  /** Offset used by the exploded view. */
  explode: Vec3;
  /** Optional hinge rotation used by the exploded ("open") view. */
  open?: { axis: Vec3; angle: number; pivot: Vec3 };
  /** Short printing advice shown in the export step. */
  tip?: string;
}

export interface Warning {
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Set on warnings produced while applying graphics, so the graphics step can show them. */
  scope?: 'graphics';
}

export interface Resolved {
  /** Outer bounding size of the closed box (mm). */
  outer: Vec3;
  /** Usable inner size (mm), when meaningful. */
  inner: Vec3;
  /** Free-form derived numbers that faces/builders share. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------- graphics

export type GraphicMode = 'emboss' | 'deboss' | 'cut' | 'inlay' | 'lithophane';

export type ShapeKind =
  | 'circle'
  | 'rect'
  | 'polygon'
  | 'star'
  | 'heart'
  | 'ring'
  | 'arrow'
  | 'bolt'
  | 'moon'
  | 'plus'
  | 'drop'
  | 'leaf';

export type PatternKind = 'hex' | 'circle' | 'slot' | 'square' | 'diamond';

export type GraphicSource =
  | {
      kind: 'text';
      text: string;
      font: string;
      align: 'left' | 'center' | 'right';
      lineSpacing: number;
      letterSpacing: number;
    }
  | { kind: 'svg'; name: string; svg: string }
  | { kind: 'image'; name: string; dataUrl: string; threshold: number; invert: boolean; detail: number }
  | { kind: 'shape'; shape: ShapeKind; sides: number; ratio: number; corner: number }
  | { kind: 'pattern'; pattern: PatternKind; cell: number; web: number };

export interface Graphic {
  id: string;
  faceId: string;
  source: GraphicSource;
  /** Centre in face coordinates (mm). */
  x: number;
  y: number;
  /** Placed size (mm). */
  w: number;
  h: number;
  lockAspect: boolean;
  /** Degrees, counter-clockwise. */
  rotation: number;
  mirror: boolean;
  mode: GraphicMode;
  /** Relief / engraving depth (mm). */
  depth: number;
  /** Preview colour, and the filament colour for inlays. */
  color: string;
  /** Lithophane thickness range (mm). */
  lithoMin: number;
  lithoMax: number;
  hidden: boolean;
}

/** A 2D outline: several layers, each filled with its own rule, all in the same coordinate space (y up). */
export interface ShapeLayer {
  rings: Vec2[][];
  fillRule: 'nonzero' | 'evenodd';
}

export interface Bounds2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Shape2D {
  layers: ShapeLayer[];
  bounds: Bounds2;
}

/** A graphic with its outline already placed in face coordinates — what the worker consumes. */
export interface PlacedGraphic {
  id: string;
  faceId: string;
  mode: GraphicMode;
  depth: number;
  color: string;
  layers: ShapeLayer[];
  /** The placed frame (centre, size, rotation, mirror) — used for lithophane windows. */
  frame: { x: number; y: number; w: number; h: number; rotation: number; mirror: boolean };
  litho?: { pixels: Uint8Array; pw: number; ph: number; min: number; max: number };
}

export interface BuildRequest {
  id: number;
  type: BoxTypeId;
  params: BoxParams;
  graphics: PlacedGraphic[];
  quality: 'draft' | 'fine';
  /** Problems found while preparing graphics (e.g. an outline that failed), reported with the result. */
  notes?: Warning[];
}

export interface MeshGroup {
  start: number;
  count: number;
  materialIndex: number;
}

export interface PartMesh {
  id: string;
  name: string;
  /** Body or a separate colour inlay that prints with its parent part. */
  role: 'body' | 'inlay';
  parentId?: string;
  /** Indexed, watertight mesh used for export. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Non-indexed copy with crease-aware normals for display; groups index into it. */
  renderPositions: Float32Array;
  renderNormals: Float32Array;
  /** Feature-edge line segments (pairs of points) for the outline overlay. */
  edges: Float32Array;
  groups: MeshGroup[];
  /** Colours by material index; index 0 is the body colour placeholder (null = use the filament colour). */
  materials: (string | null)[];
  print: Mat4;
  explode: Vec3;
  open?: { axis: Vec3; angle: number; pivot: Vec3 };
  tip?: string;
  volume: number;
  triangles: number;
  /** Bounding box in print orientation (before layout translation). */
  printMin: Vec3;
  printMax: Vec3;
}

export interface BuildResult {
  id: number;
  parts: PartMesh[];
  faces: FaceDef[];
  warnings: Warning[];
  ms: number;
}
