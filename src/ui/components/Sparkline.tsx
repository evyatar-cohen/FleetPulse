// A small live line chart (SVG) for one sensor over the last ~5 minutes of TRUSTED values. Gaps = no trusted value.
import type { ReactElement } from 'react';
import { chartRange, sparklineSegments, type ChartRange } from '../chart';

const WIDTH = 300;
const HEIGHT = 60;

interface SparklineProps {
  label: string;
  unit: string;
  values: readonly (number | null)[];
  fixedRange?: ChartRange;
}

export function Sparkline({ label, unit, values, fixedRange }: SparklineProps): ReactElement {
  const range = chartRange(values, fixedRange);
  const segments = sparklineSegments(values, WIDTH, HEIGHT, range);
  const latest = values.at(-1);
  return (
    <div className="sparkline">
      <div className="sparkline-header">
        <span>{label}</span>
        <strong>{latest === undefined || latest === null ? '—' : `${latest.toFixed(0)} ${unit}`}</strong>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${label} chart`}>
        {segments.map((points, index) => (
          <polyline key={index} points={points} className="sparkline-line" />
        ))}
      </svg>
      <div className="sparkline-scale muted">
        {range.min.toFixed(0)}–{range.max.toFixed(0)} {unit} · last {values.length * 2} s
      </div>
    </div>
  );
}
