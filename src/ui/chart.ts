// Pure helper for the detail-panel sparklines: turns a series of values into SVG polyline segments.
// A null value (no trusted reading at that moment) breaks the line — we don't draw across unknown data.

export interface ChartRange {
  min: number;
  max: number;
}

// Range of the known values, padded so a flat line isn't stuck to an edge. `fixed` overrides (e.g. fuel 0–100).
export function chartRange(values: readonly (number | null)[], fixed?: ChartRange): ChartRange {
  if (fixed !== undefined) return fixed;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === Infinity) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

// One "x,y x,y …" string per unbroken run of values, spread evenly across `width`, `height` px (y grows down).
export function sparklineSegments(
  values: readonly (number | null)[],
  width: number,
  height: number,
  range: ChartRange,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const span = range.max - range.min;

  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push(current.join(' '));
      current = [];
      return;
    }
    const clamped = Math.min(Math.max(value, range.min), range.max);
    const x = index * stepX;
    const y = height - ((clamped - range.min) / span) * height;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 0) segments.push(current.join(' '));
  return segments;
}
