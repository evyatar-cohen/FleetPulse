// Speed detector — QUIRK #3: a stuck sensor reports an impossible speed (999 km/h on the mock server).
// Generic rule: outside 0..profile.maxSpeedKmh is physically impossible → keep showing the last valid speed
// (null if none yet) and flag sensor_fault. No truck id, no hardcoded 999.
import type { TelemetryReading } from '../../models';
import type { VehicleProfile } from '../../vehicles';
import type { SensorDetector, SensorState } from '../sensors';

function isPlausibleSpeed(speed: number, profile: VehicleProfile): boolean {
  return speed >= 0 && speed <= profile.maxSpeedKmh;
}

export const speedDetector: SensorDetector = {
  id: 'speed',
  evaluate(previous: SensorState | undefined, reading: TelemetryReading, profile: VehicleProfile): SensorState {
    if (isPlausibleSpeed(reading.speed, profile)) {
      return { value: reading.speed, status: 'ok' };
    }

    const lastValidValue = previous === undefined ? null : previous.value;
    // Keep the episode start if we were already in a fault; otherwise this reading starts one.
    const alreadyFaulty = previous !== undefined && previous.status === 'sensor_fault' && previous.since !== undefined;
    const since = alreadyFaulty ? previous.since : reading.timestamp;
    return { value: lastValidValue, status: 'sensor_fault', since };
  },
};
