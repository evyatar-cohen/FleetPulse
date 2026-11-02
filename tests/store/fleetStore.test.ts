// Feature: Store wiring (actions are thin: call a domain function, save the result)
// Tests:   src/store/fleetStore.ts → useFleetStore actions (used outside React here, via getState())
// Rule:    actions update the right state; nothing changes when the domain returns the same data.
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetResponseSchema } from '../../src/domain/api';
import { SseEventSchema } from '../../src/domain/events';
import { useFleetStore } from '../../src/store/fleetStore';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import heartbeatFixture from '../../fixtures/sse/heartbeat.json';
import telemetryFixture from '../../fixtures/sse/telemetry.json';

const fleetResponse = FleetResponseSchema.parse(fleetFixture.body);

beforeEach(() => {
  useFleetStore.getState().resetFleet();
  useFleetStore.getState().setFleetStale(false);
});

describe('Store wiring', () => {
  it('applyFleetResponse loads trucks, records when, and clears "stale"', () => {
    useFleetStore.getState().setFleetStale(true);
    useFleetStore.getState().applyFleetResponse(fleetResponse);
    const state = useFleetStore.getState();
    expect(Object.keys(state.trucks)).toHaveLength(12);
    expect(state.fleetFetchedAt).toBe(fleetResponse.timestamp);
    expect(state.fleetStale).toBe(false);
  });

  it('applySseEvent runs telemetry through the pipeline and tracks the server time', () => {
    const event = SseEventSchema.parse(telemetryFixture);
    useFleetStore.getState().applySseEvent(event);
    const state = useFleetStore.getState();
    expect(Object.keys(state.trucks)).toHaveLength(12);
    expect(state.serverTime).toBe(telemetryFixture.timestamp);
  });

  it('a heartbeat only moves the server time — trucks object stays the same (no redraw)', () => {
    useFleetStore.getState().applyFleetResponse(fleetResponse);
    const trucksBefore = useFleetStore.getState().trucks;
    useFleetStore.getState().applySseEvent(SseEventSchema.parse(heartbeatFixture));
    expect(useFleetStore.getState().trucks).toBe(trucksBefore);
  });

  it('resetFleet (fleet_reset) drops all trucks', () => {
    useFleetStore.getState().applyFleetResponse(fleetResponse);
    useFleetStore.getState().resetFleet();
    expect(useFleetStore.getState().trucks).toEqual({});
  });
});
