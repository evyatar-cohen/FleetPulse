// Fleet map as a simple SVG coordinate grid (D31): one dot per truck at its CURRENT position (newest accepted
// reading), colored by status, plus its recent path line (live + late + GPS batch points — QUIRK #1: a batch fills
// the path, it never adds 30 markers). Reads trucks through the 1 s throttled hook.
// Trucks not matching the fleet filter are dimmed, not removed: removing them would rescale the map and move the rest.
import type { ReactElement } from 'react';
import { truckStatus, type TruckView } from '../../domain/fleet';
import type { Location } from '../../domain/models';
import { useFleetStore } from '../../store/fleetStore';
import { STATUS_COLORS } from '../format';
import { createProjection, MAP_SIZE, type Projection } from '../mapProjection';
import { selectTrucks, sortedTrucks } from '../selectors';
import { matchesFilter, type TruckFilter } from '../truckFilter';
import { useThrottledStore } from '../useThrottledStore';

const GRID_LINES = 8;

function allLocations(trucks: readonly TruckView[]): Location[] {
  const locations: Location[] = [];
  for (const truck of trucks) {
    for (const point of truck.telemetry?.path ?? []) {
      locations.push(point);
    }
  }
  return locations;
}

function Grid(): ReactElement {
  const lines: ReactElement[] = [];
  for (let i = 1; i < GRID_LINES; i++) {
    const x = (MAP_SIZE.width / GRID_LINES) * i;
    const y = (MAP_SIZE.height / GRID_LINES) * i;
    lines.push(<line key={`v${i}`} x1={x} y1={0} x2={x} y2={MAP_SIZE.height} className="grid-line" />);
    lines.push(<line key={`h${i}`} x1={0} y1={y} x2={MAP_SIZE.width} y2={y} className="grid-line" />);
  }
  return <g>{lines}</g>;
}

function TruckPath({ truck, projection }: { truck: TruckView; projection: Projection }): ReactElement | null {
  const path = truck.telemetry?.path ?? [];
  if (path.length < 2) return null;
  const points = path.map((point) => {
    const { x, y } = projection.toPoint(point);
    return `${x},${y}`;
  });
  return <polyline points={points.join(' ')} className="truck-path" stroke={STATUS_COLORS[truckStatus(truck)]} />;
}

interface TruckMarkerProps {
  truck: TruckView;
  projection: Projection;
  selected: boolean;
  onSelect: (truckId: string) => void;
}

function TruckMarker({ truck, projection, selected, onSelect }: TruckMarkerProps): ReactElement | null {
  const current = truck.telemetry?.current;
  if (current === undefined) return null;
  const { x, y } = projection.toPoint(current.location);
  return (
    <g className="clickable" onClick={() => onSelect(truck.id)}>
      {selected && <circle cx={x} cy={y} r={13} className="selected-ring" />}
      <circle cx={x} cy={y} r={7} fill={STATUS_COLORS[truckStatus(truck)]} className="truck-marker">
        <title>{`${truck.name} — ${truckStatus(truck)}`}</title>
      </circle>
      <text x={x + 10} y={y + 4} className="truck-label">
        {truck.name.replace('Truck ', '')}
      </text>
    </g>
  );
}

export function FleetMap({ onSelect, filter }: { onSelect: (truckId: string) => void; filter: TruckFilter }): ReactElement {
  const trucks = sortedTrucks(useThrottledStore(selectTrucks));
  const selectedTruckId = useFleetStore((state) => state.selectedTruckId);
  const projection = createProjection(allLocations(trucks));

  return (
    <section className="panel">
      <h2>Map</h2>
      <svg viewBox={`0 0 ${MAP_SIZE.width} ${MAP_SIZE.height}`} className="fleet-map" role="img" aria-label="Fleet map">
        <Grid />
        {trucks.map((truck) => (
          <g key={`path-${truck.id}`} className={matchesFilter(truck, filter) ? undefined : 'filtered-out'}>
            <TruckPath truck={truck} projection={projection} />
          </g>
        ))}
        {trucks.map((truck) => (
          <g key={`marker-${truck.id}`} className={matchesFilter(truck, filter) ? undefined : 'filtered-out'}>
            <TruckMarker
              truck={truck}
              projection={projection}
              selected={truck.id === selectedTruckId}
              onSelect={onSelect}
            />
          </g>
        ))}
      </svg>
      <div className="legend">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <span key={status}>
            <span className="status-dot" style={{ backgroundColor: color }} />
            {status}
          </span>
        ))}
      </div>
    </section>
  );
}
