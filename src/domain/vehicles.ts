// Vehicle profiles: every per-type physical limit lives here, keyed by vehicle type.
// Detectors read limits from the profile, never from hardcoded numbers.
// To add a vehicle type: add one entry to VEHICLE_PROFILES (the server must send that `vehicleType`).

export interface VehicleProfile {
  // Above this (or below 0) a speed reading is physically impossible → sensor fault.
  maxSpeedKmh: number;
  // Faster fuel change (either direction, in % points per second) is physically impossible → suspect a glitch.
  // Real consumption is ~0.01 pts/s; refueling ~1 pt/s. Limitation: below ~3% a drop to 0 fits the allowance.
  maxFuelChangePerSecond: number;
}

export const VEHICLE_PROFILES = {
  // Heavy delivery trucks top out around 120–150 km/h; margin for real fast driving.
  truck: { maxSpeedKmh: 160, maxFuelChangePerSecond: 1.5 },
} satisfies Record<string, VehicleProfile>;

export type VehicleType = keyof typeof VEHICLE_PROFILES;

// The mock server sends no vehicle type, so every vehicle is a truck until it does.
export const DEFAULT_VEHICLE_TYPE: VehicleType = 'truck';

function isKnownVehicleType(type: string): type is VehicleType {
  return Object.hasOwn(VEHICLE_PROFILES, type);
}

// Unknown or missing type → default profile, so a new type from the server never crashes the app.
export function getVehicleProfile(type: string | undefined): VehicleProfile {
  if (type !== undefined && isKnownVehicleType(type)) {
    return VEHICLE_PROFILES[type];
  }
  return VEHICLE_PROFILES[DEFAULT_VEHICLE_TYPE];
}
