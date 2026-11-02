// Low-fuel alert. Uses ONLY the trusted fuel value from the fuel detector (sensors.fuel), never the raw reading:
//   QUIRK #2 glitch to 0% → the trusted value stays at the last good level → no false alarm;
//   a real low level with a glitch → the trusted value stays low → the alert stays on;
//   an unverified sudden "rise" (10% → 80%) → the trusted value stays 10% until confirmed → the alert stays on.
// The threshold comes from the vehicle profile (what counts as "low" depends on the tank).
import type { VehicleProfile } from '../vehicles';
import type { SensorState } from './sensors';

export function isLowFuel(fuel: SensorState | undefined, profile: VehicleProfile): boolean {
  if (fuel === undefined || fuel.value === null) return false;
  return fuel.value < profile.lowFuelPercent;
}
