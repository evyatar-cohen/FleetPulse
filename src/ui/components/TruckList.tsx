// Truck list: status, trusted speed/fuel with sensor flags, and data age, for every truck matching the filter.
// Reads trucks through the 1 s throttled hook (live data changes every 2 s plus bursts).
import type { ReactElement } from 'react';
import { truckStatus, type TruckView } from '../../domain/fleet';
import { viewersOf } from '../../domain/presence';
import { isLowFuel } from '../../domain/telemetry/fuelAlert';
import { getVehicleProfile } from '../../domain/vehicles';
import { formatAge, formatFuel, formatSpeed, LOW_FUEL_FLAG, STATUS_COLORS, type SensorDisplay } from '../format';
import { useFleetStore } from '../../store/fleetStore';
import { dispatcherLabel } from '../routeFormat';
import { selectTrucks, sortedTrucks } from '../selectors';
import { matchesFilter, type TruckFilter } from '../truckFilter';
import { TruckFilterBar } from './TruckFilterBar';
import { useNow } from '../useNow';
import { useThrottledStore } from '../useThrottledStore';

function SensorCell({ display }: { display: SensorDisplay }): ReactElement {
  const flagClass = display.flag === LOW_FUEL_FLAG ? 'sensor-flag low-fuel' : 'sensor-flag';
  return (
    <td title={display.flag ?? undefined}>
      {display.text}
      {display.flag !== null && <span className={flagClass}> {display.flag}</span>}
    </td>
  );
}

interface TruckRowProps {
  truck: TruckView;
  now: number;
  selected: boolean;
  viewerNames: string[];
  onSelect: (truckId: string) => void;
}

function TruckRow({ truck, now, selected, viewerNames, onSelect }: TruckRowProps): ReactElement {
  const status = truckStatus(truck);
  const telemetry = truck.telemetry;
  const fuel = telemetry?.sensors['fuel'];
  return (
    <tr className={selected ? 'clickable selected' : 'clickable'} onClick={() => onSelect(truck.id)}>
      <td title={viewerNames.length > 0 ? `Also viewing: ${viewerNames.join(', ')}` : undefined}>
        <span className="status-dot" style={{ backgroundColor: STATUS_COLORS[status] }} />
        {truck.name}
        {viewerNames.length > 0 && <span className="viewer-tag"> 👁 {viewerNames.join(', ')}</span>}
      </td>
      <td>{status}</td>
      <SensorCell display={formatSpeed(telemetry?.sensors['speed'])} />
      <SensorCell display={formatFuel(fuel, isLowFuel(fuel, getVehicleProfile(truck.vehicleType)))} />
      <td className="muted">{formatAge(telemetry?.current.timestamp, now)}</td>
    </tr>
  );
}

interface TruckListProps {
  onSelect: (truckId: string) => void;
  filter: TruckFilter;
  onFilterChange: (filter: TruckFilter) => void;
}

export function TruckList({ onSelect, filter, onFilterChange }: TruckListProps): ReactElement {
  const trucks = useThrottledStore(selectTrucks);
  const presence = useFleetStore((state) => state.presence);
  const selectedTruckId = useFleetStore((state) => state.selectedTruckId);
  const myId = useFleetStore((state) => state.dispatcherId);
  const names = useFleetStore((state) => state.dispatcherNames);
  const now = useNow();
  const allRows = sortedTrucks(trucks);
  const rows = allRows.filter((truck) => matchesFilter(truck, filter));

  return (
    <section className="panel">
      <h2>
        Trucks ({rows.length === allRows.length ? rows.length : `${rows.length} of ${allRows.length}`}){' '}
        <span className="muted hint">— click a truck for details</span>
      </h2>
      <TruckFilterBar filter={filter} onChange={onFilterChange} />
      <table className="truck-table">
        {/* Fixed column widths: values and flags appearing/disappearing must not move the columns. */}
        <colgroup>
          <col style={{ width: '26%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '23%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Truck</th>
            <th>Status</th>
            <th>Speed</th>
            <th>Fuel</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((truck) => (
            <TruckRow
              key={truck.id}
              truck={truck}
              now={now}
              selected={truck.id === selectedTruckId}
              viewerNames={viewersOf(presence, truck.id).map((viewer) => dispatcherLabel(viewer.id, myId, names))}
              onSelect={onSelect}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No trucks match the filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
