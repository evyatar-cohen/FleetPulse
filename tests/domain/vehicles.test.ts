// Feature: Vehicle profiles (extensibility — new vehicle types)
// Tests:   src/domain/vehicles.ts → getVehicleProfile(); src/domain/models.ts → FleetTruckSchema.vehicleType
// Rule:    every vehicle limit comes from its type's profile. Adding a type = adding one profile entry.
//          The server sends no type today → default 'truck'. Unknown type → default profile, never a crash.
import { describe, expect, it } from 'vitest';
import { FleetResponseSchema } from '../../src/domain/api';
import {
  DEFAULT_VEHICLE_TYPE,
  getVehicleProfile,
  VEHICLE_PROFILES,
} from '../../src/domain/vehicles';
import fleetFixture from '../../fixtures/rest/fleet_200.json';

describe('Vehicle profiles', () => {
  it('a known type returns its own profile', () => {
    expect(getVehicleProfile('truck')).toBe(VEHICLE_PROFILES.truck);
  });

  it('an unknown type falls back to the default profile', () => {
    expect(getVehicleProfile('drone')).toBe(VEHICLE_PROFILES[DEFAULT_VEHICLE_TYPE]);
  });

  it('a missing type falls back to the default profile', () => {
    expect(getVehicleProfile(undefined)).toBe(VEHICLE_PROFILES[DEFAULT_VEHICLE_TYPE]);
  });

  it('real server data: fleet trucks without vehicleType get the default type', () => {
    const response = FleetResponseSchema.parse(fleetFixture.body);
    for (const truck of response.fleet) {
      expect(truck.vehicleType).toBe(DEFAULT_VEHICLE_TYPE);
    }
  });

  it('a vehicleType sent by the server is kept', () => {
    const withType = { ...fleetFixture.body, fleet: [{ ...fleetFixture.body.fleet[0], vehicleType: 'van' }] };
    expect(FleetResponseSchema.parse(withType).fleet[0]?.vehicleType).toBe('van');
  });
});
