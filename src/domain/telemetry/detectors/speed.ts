// Speed detector — QUIRK #3: a stuck sensor reports an impossible speed (999 km/h on the mock server).
// Generic rule: outside 0..profile.maxSpeedKmh is physically impossible → keep showing the last valid speed
// (null if none yet) and flag sensor_fault. No truck id, no hardcoded 999.
import type { TelemetryReading } from '../../models';
import type { VehicleProfile } from '../../vehicles';
import { keepTrusted, type SensorDetector, type SensorState } from '../sensors';

function isPlausibleSpeed(speed: number, profile: VehicleProfile): boolean {
  return speed >= 0 && speed <= profile.maxSpeedKmh;
}

export const speedDetector: SensorDetector = {
  id: 'speed',
  evaluate(previous: SensorState | undefined, reading: TelemetryReading, profile: VehicleProfile): SensorState {
    if (isPlausibleSpeed(reading.speed, profile)) {
      return { value: reading.speed, status: 'ok' };
    }
    return keepTrusted(previous, 'sensor_fault', reading.timestamp);
  },
};
