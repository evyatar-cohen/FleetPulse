// Truck list: status, trusted speed/fuel with sensor flags, and data age, for every truck.
// Reads trucks through the 1 s throttled hook (live data changes every 2 s plus bursts).
import type { ReactElement } from 'react';
import { truckStatus, type TruckView } from '../../domain/fleet';
import { isLowFuel } from '../../domain/telemetry/fuelAlert';
import { getVehicleProfile } from '../../domain/vehicles';
import { formatAge, formatFuel, formatSpeed, LOW_FUEL_FLAG, STATUS_COLORS, type SensorDisplay } from '../format';
import { selectTrucks, sortedTrucks } from '../selectors';
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

function TruckRow({ truck, now }: { truck: TruckView; now: number }): ReactElement {
  const status = truckStatus(truck);
  const telemetry = truck.telemetry;
  const fuel = telemetry?.sensors['fuel'];
  return (
    <tr>
      <td>
        <span className="status-dot" style={{ backgroundColor: STATUS_COLORS[status] }} />
        {truck.name}
      </td>
      <td>{status}</td>
      <SensorCell display={formatSpeed(telemetry?.sensors['speed'])} />
      <SensorCell display={formatFuel(fuel, isLowFuel(fuel, getVehicleProfile(truck.vehicleType)))} />
      <td className="muted">{formatAge(telemetry?.current.timestamp, now)}</td>
    </tr>
  );
}

export function TruckList(): ReactElement {
  const trucks = useThrottledStore(selectTrucks);
  const now = useNow();
  const rows = sortedTrucks(trucks);

  return (
    <section className="panel">
      <h2>Trucks ({rows.length})</h2>
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
            <TruckRow key={truck.id} truck={truck} now={now} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
