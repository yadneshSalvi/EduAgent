/**
 * Mastery ramp (plans/05 §2): 5 stops, continuous interpolation. Fading is
 * NEVER encoded by hue-shifting this ramp — overlay --warn + a decay glyph.
 */
const RAMP: Array<[number, string]> = [
  [0.0, '#2A2E3A'],
  [0.25, '#3B4C6B'],
  [0.5, '#2F6F8F'],
  [0.75, '#2E9E7A'],
  [1.0, '#3ECF8E'],
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const to = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** Interpolated ramp color for a mastery score 0..1 (clamped). */
export function masteryColor(score: number): string {
  const v = Math.min(1, Math.max(0, score));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const lower = RAMP[i];
    const upper = RAMP[i + 1];
    if (!lower || !upper) break;
    const [start, startHex] = lower;
    const [end, endHex] = upper;
    if (v <= end) {
      const t = (v - start) / (end - start);
      const a = hexToRgb(startHex);
      const b = hexToRgb(endHex);
      return rgbToHex([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ]);
    }
  }
  return '#3ECF8E';
}

/** Mastery scores always render with two decimals (mono, e.g. `0.40→0.72`). */
export function formatMastery(score: number): string {
  return score.toFixed(2);
}
