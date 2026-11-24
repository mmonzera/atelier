import type { AgentAvatarShape, AgentColor } from '@atelier/contracts';

export interface MascotColorSpec {
  label: string;
  hex: string;
  base: [number, number, number];
  deep: [number, number, number];
  rim: [number, number, number];
}

function rgb(r: number, g: number, b: number): [number, number, number] {
  return [r / 255, g / 255, b / 255];
}

export const MASCOT_COLORS: Record<AgentColor, MascotColorSpec> = {
  // Row 1 (9 vibrant tones matching reference palette)
  blue: {
    label: 'Cobalt Blue',
    hex: '#3b8df7',
    base: rgb(42, 134, 248),
    deep: rgb(11, 56, 148),
    rim: rgb(146, 212, 255),
  },
  red: {
    label: 'Poppy Red',
    hex: '#ef4d42',
    base: rgb(236, 72, 58),
    deep: rgb(134, 22, 18),
    rim: rgb(255, 162, 144),
  },
  orange: {
    label: 'Tangerine',
    hex: '#f28c28',
    base: rgb(242, 138, 36),
    deep: rgb(148, 62, 8),
    rim: rgb(255, 206, 128),
  },
  amber: {
    label: 'Marigold',
    hex: '#f4bc2e',
    base: rgb(242, 186, 42),
    deep: rgb(156, 94, 8),
    rim: rgb(255, 232, 140),
  },
  lime: {
    label: 'Apple Lime',
    hex: '#84cc29',
    base: rgb(130, 204, 42),
    deep: rgb(54, 114, 12),
    rim: rgb(206, 246, 136),
  },
  green: {
    label: 'Mint Emerald',
    hex: '#38c976',
    base: rgb(48, 202, 114),
    deep: rgb(14, 108, 56),
    rim: rgb(148, 246, 192),
  },
  teal: {
    label: 'Lagoon Teal',
    hex: '#27b998',
    base: rgb(36, 186, 152),
    deep: rgb(10, 96, 82),
    rim: rgb(138, 240, 218),
  },
  cyan: {
    label: 'Sky Cyan',
    hex: '#2bb4f4',
    base: rgb(42, 180, 244),
    deep: rgb(10, 92, 148),
    rim: rgb(152, 230, 255),
  },
  sky: {
    label: 'Azure',
    hex: '#4e90f7',
    base: rgb(74, 144, 248),
    deep: rgb(22, 66, 152),
    rim: rgb(168, 208, 255),
  },

  // Row 2 (9 deeper / pastel tones matching reference palette)
  indigo: {
    label: 'Midnight Indigo',
    hex: '#3b52ad',
    base: rgb(58, 82, 174),
    deep: rgb(22, 34, 96),
    rim: rgb(146, 168, 244),
  },
  cobalt: {
    label: 'Electric Periwinkle',
    hex: '#5c75f7',
    base: rgb(90, 114, 248),
    deep: rgb(36, 48, 148),
    rim: rgb(172, 188, 255),
  },
  purple: {
    label: 'Plush Violet',
    hex: '#9b67f7',
    base: rgb(154, 100, 246),
    deep: rgb(78, 36, 148),
    rim: rgb(214, 182, 255),
  },
  magenta: {
    label: 'Berry Magenta',
    hex: '#dc4fa8',
    base: rgb(218, 76, 166),
    deep: rgb(124, 24, 88),
    rim: rgb(252, 166, 224),
  },
  pink: {
    label: 'Bubblegum Rose',
    hex: '#f283a2',
    base: rgb(242, 130, 162),
    deep: rgb(150, 48, 82),
    rim: rgb(255, 202, 220),
  },
  crimson: {
    label: 'Velvet Plum',
    hex: '#a83252',
    base: rgb(168, 48, 82),
    deep: rgb(88, 16, 38),
    rim: rgb(232, 134, 162),
  },
  brown: {
    label: 'Cocoa Bear',
    hex: '#8a5b3e',
    base: rgb(140, 92, 62),
    deep: rgb(74, 42, 24),
    rim: rgb(212, 164, 132),
  },
  sand: {
    label: 'Oat Biscuit',
    hex: '#d8be92',
    base: rgb(214, 188, 142),
    deep: rgb(134, 106, 66),
    rim: rgb(248, 232, 198),
  },
  slate: {
    label: 'Silver Puff',
    hex: '#a8a8b2',
    base: rgb(168, 168, 178),
    deep: rgb(86, 88, 98),
    rim: rgb(232, 234, 242),
  },
};

export interface MascotShapeSpec {
  id: AgentAvatarShape;
  shaderIndex: number;
  label: string;
  showcaseColor: AgentColor;
  eyeLayout: [number, number];
}

export const MASCOT_SHAPES: MascotShapeSpec[] = [
  { id: 'orb', shaderIndex: 0, label: 'Orb', showcaseColor: 'purple', eyeLayout: [0.135, 0.05] },
  { id: 'squircle', shaderIndex: 1, label: 'Squircle', showcaseColor: 'red', eyeLayout: [0.135, 0.04] },
  { id: 'triangle', shaderIndex: 2, label: 'Triangle', showcaseColor: 'blue', eyeLayout: [0.105, -0.02] },
  { id: 'hex', shaderIndex: 3, label: 'Hexagon', showcaseColor: 'magenta', eyeLayout: [0.135, 0.04] },
  { id: 'cube', shaderIndex: 4, label: 'Cube', showcaseColor: 'purple', eyeLayout: [0.13, 0.06] },
  { id: 'pebble', shaderIndex: 5, label: 'Pebble', showcaseColor: 'red', eyeLayout: [0.13, 0.03] },
  { id: 'pentagon', shaderIndex: 6, label: 'Pentagon', showcaseColor: 'blue', eyeLayout: [0.125, 0.03] },
  { id: 'pill', shaderIndex: 7, label: 'Loaf', showcaseColor: 'purple', eyeLayout: [0.155, 0.03] },
  { id: 'diamond', shaderIndex: 8, label: 'Diamond', showcaseColor: 'red', eyeLayout: [0.115, 0.03] },
  { id: 'cloud', shaderIndex: 9, label: 'Cloud', showcaseColor: 'magenta', eyeLayout: [0.13, 0.04] },
  { id: 'barrel', shaderIndex: 10, label: 'Barrel', showcaseColor: 'sky', eyeLayout: [0.13, 0.07] },
  { id: 'blob', shaderIndex: 11, label: 'Drop', showcaseColor: 'red', eyeLayout: [0.125, 0.02] },
];

export const MASCOT_SHAPE_MAP: Record<AgentAvatarShape, MascotShapeSpec> = MASCOT_SHAPES.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<AgentAvatarShape, MascotShapeSpec>,
);

const FALLBACK_SHAPE_CYCLE: AgentAvatarShape[] = [
  'triangle',
  'orb',
  'squircle',
  'cloud',
  'hex',
  'pentagon',
  'diamond',
  'pill',
  'cube',
  'pebble',
  'barrel',
  'blob',
];

export function hashSeed(seed?: string): number {
  if (!seed) return 0.37;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function resolveMascotShape(
  explicitShape?: AgentAvatarShape,
  seed?: string,
): AgentAvatarShape {
  if (explicitShape && MASCOT_SHAPE_MAP[explicitShape]) {
    return explicitShape;
  }
  const idx = Math.floor(hashSeed(seed) * FALLBACK_SHAPE_CYCLE.length) % FALLBACK_SHAPE_CYCLE.length;
  return FALLBACK_SHAPE_CYCLE[idx];
}

export function resolveMascotColor(color?: AgentColor): MascotColorSpec {
  if (color && MASCOT_COLORS[color]) {
    return MASCOT_COLORS[color];
  }
  return MASCOT_COLORS.blue;
}
