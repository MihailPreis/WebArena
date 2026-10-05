// Clutter of the map, built from coloured boxes like voxel models. Pure data, so
// that a map can be checked against it without a renderer.
import type { Vec3 } from '../sim/map';

export interface PropPart {
  /** Corners of a box, in metres, relative to the point on the floor under the prop. */
  min: Vec3;
  max: Vec3;
  color: string;
  /** Drawn at full brightness whatever the light: screens and lamps. */
  glow?: boolean;
}

function box(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  color: string,
  glow = false,
): PropPart {
  return { min: [x0, y0, z0], max: [x1, y1, z1], color, glow };
}

/** Four legs under a rectangle. */
function legs(half: number, height: number, color: string): PropPart[] {
  const t = 0.04;
  return [
    box(-half, 0, -half, -half + t, height, -half + t, color),
    box(half - t, 0, -half, half, height, -half + t, color),
    box(-half, 0, half - t, -half + t, height, half, color),
    box(half - t, 0, half - t, half, height, half, color),
  ];
}

export const PROP_MODELS: Record<string, PropPart[]> = {
  barrel: [
    box(-0.28, 0, -0.28, 0.28, 0.9, 0.28, '#3f6b8a'),
    box(-0.31, 0.16, -0.31, 0.31, 0.24, 0.31, '#2b4a61'),
    box(-0.31, 0.64, -0.31, 0.31, 0.72, 0.31, '#2b4a61'),
    box(-0.24, 0.9, -0.24, 0.24, 0.93, 0.24, '#5587a8'),
    box(-0.06, 0.93, 0.08, 0.06, 0.96, 0.18, '#d6a94a'),
  ],
  cone: [
    box(-0.2, 0, -0.2, 0.2, 0.05, 0.2, '#26262b'),
    box(-0.14, 0.05, -0.14, 0.14, 0.24, 0.14, '#ff7a2e'),
    box(-0.1, 0.24, -0.1, 0.1, 0.4, 0.1, '#f4f1ea'),
    box(-0.06, 0.4, -0.06, 0.06, 0.6, 0.06, '#ff7a2e'),
  ],
  plant: [
    box(-0.18, 0, -0.18, 0.18, 0.3, 0.18, '#8a4b32'),
    box(-0.15, 0.3, -0.15, 0.15, 0.33, 0.15, '#3a2a20'),
    box(-0.03, 0.33, -0.03, 0.03, 0.75, 0.03, '#2e6b3a'),
    box(-0.32, 0.6, -0.07, 0.32, 0.7, 0.07, '#3f9950'),
    box(-0.07, 0.7, -0.32, 0.07, 0.8, 0.32, '#4fb463'),
    box(-0.18, 0.82, -0.18, 0.18, 0.98, 0.18, '#3f9950'),
    box(-0.08, 0.98, -0.08, 0.08, 1.1, 0.08, '#6fd083'),
  ],
  monitor: [
    box(-0.25, 0, -0.2, 0.25, 0.06, 0.2, '#33373f'),
    box(-0.05, 0.06, -0.05, 0.05, 0.9, 0.05, '#565d69'),
    box(-0.36, 0.9, -0.06, 0.36, 1.42, 0.06, '#1d2027'),
    box(-0.31, 0.95, 0.06, 0.31, 1.37, 0.075, '#48dbfb', true),
    box(-0.25, 1.22, 0.075, 0.1, 1.26, 0.08, '#e9fbff', true),
    box(-0.25, 1.1, 0.075, 0.2, 1.14, 0.08, '#e9fbff', true),
  ],
  lamp: [
    box(-0.16, 0, -0.16, 0.16, 0.05, 0.16, '#33373f'),
    box(-0.035, 0.05, -0.035, 0.035, 1.6, 0.035, '#565d69'),
    box(-0.13, 1.6, -0.13, 0.13, 1.86, 0.13, '#ffcf5a', true),
    box(-0.15, 1.86, -0.15, 0.15, 1.9, 0.15, '#33373f'),
  ],
  boxes: [
    box(-0.32, 0, -0.26, 0.32, 0.42, 0.26, '#b08a5a'),
    box(-0.05, 0, -0.265, 0.05, 0.425, 0.265, '#d8c08e'),
    box(-0.2, 0.42, -0.2, 0.22, 0.72, 0.18, '#9c7848'),
    box(-0.2, 0.55, -0.205, 0.22, 0.6, 0.185, '#d8c08e'),
  ],
  bottles: [
    box(-0.26, 0, -0.18, 0.26, 0.1, 0.18, '#4a4f5c'),
    box(-0.2, 0.1, -0.12, -0.12, 0.38, -0.04, '#3f9950'),
    box(-0.04, 0.1, -0.12, 0.04, 0.34, -0.04, '#8a4b32'),
    box(0.12, 0.1, -0.12, 0.2, 0.4, -0.04, '#3f9950'),
    box(-0.2, 0.1, 0.04, -0.12, 0.34, 0.12, '#8a4b32'),
    box(-0.04, 0.1, 0.04, 0.04, 0.4, 0.12, '#48dbfb'),
    box(0.12, 0.1, 0.04, 0.2, 0.36, 0.12, '#8a4b32'),
  ],
  chair: [
    ...legs(0.22, 0.42, '#33373f'),
    box(-0.23, 0.42, -0.23, 0.23, 0.48, 0.23, '#c0392b'),
    box(-0.23, 0.48, 0.18, 0.23, 0.98, 0.23, '#c0392b'),
    box(-0.23, 0.98, 0.17, 0.23, 1.02, 0.24, '#33373f'),
  ],
};

// Shown for prop types the renderer does not know, so a new map still renders.
export const MISSING_PROP: PropPart[] = [box(-0.25, 0, -0.25, 0.25, 0.5, 0.25, '#cc00cc')];
