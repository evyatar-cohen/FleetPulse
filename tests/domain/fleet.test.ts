// Feature: Fleet state (REST snapshot + live telemetry per truck)
// Tests:   src/domain/fleet.ts → applyFleetSnapshot(), applyTelemetryEvent(), truckStatus()
// Rule:    the snapshot gives every truck its info and a first position; SSE events run through the Phase 2 pipeline;
//          an older snapshot never overwrites newer live data; unchanged input returns the SAME object (no redraw).
import { describe, expect, it } from 'vitest';
import { FleetResponseSchema } from '../../src/domain/api';
import { SseEventSchema, type SseEvent } from '../../src/domain/events';
import {
  applyFleetSnapshot,
  applyTelemetryEvent,
  truckStatus,
  type Trucks,
} from '../../src/domain/fleet';
import fleetFixture from '../../fixtures/rest/fleet_200.json';
import batchFixture from '../../fixtures/sse/gps_batch.json';
import heartbeatFixture from '../../fixtures/sse/heartbeat.json';
import telemetryFixture from '../../fixtures/sse/telemetry.json';

const fleetResponse = FleetResponseSchema.parse(fleetFixture.body);

function sse(raw: unknown): SseEvent {
  return SseEventSchema.parse(raw);
}

function telemetryEvent(): Extract<SseEvent, { type: 'telemetry' }> {
  const event = sse(telemetryFixture);
  if (event.type !== 'telemetry') throw new Error('not telemetry');
  return event;
}

function loadedFleet(): Trucks {
  return applyFleetSnapshot({}, fleetResponse.fleet, fleetResponse.timestamp);
}

describe('Fleet state — REST snapshot', () => {
  it('creates all 12 trucks with name, status and a first position from the snapshot', () => {
    const trucks = loadedFleet();
    expect(Object.keys(trucks)).toHaveLength(12);
    const truck = trucks['truck_1'];
    expect(truck?.name).toBe('Truck Alpha');
    expect(truck?.telemetry?.current.location).toEqual(fleetResponse.fleet[0]?.location);
    expect(truck?.vehicleType).toBe('truck');
  });

  it('an older snapshot does not overwrite newer live telemetry', () => {
    const event = telemetryEvent();
    const live = applyTelemetryEvent({}, event, event.timestamp);
    const olderSnapshot = applyFleetSnapshot(live, fleetResponse.fleet, event.timestamp - 60_000);
    const truckId = event.readings[0]?.truckId ?? '';
    expect(olderSnapshot[truckId]?.telemetry?.current.timestamp).toBe(event.timestamp);
  });

  it('trucks missing from a new snapshot are removed', () => {
    const trucks = applyFleetSnapshot(loadedFleet(), fleetResponse.fleet.slice(0, 3), fleetResponse.timestamp + 1);
    expect(Object.keys(trucks)).toHaveLength(3);
  });
});

describe('Fleet state — live telemetry', () => {
  it('a telemetry event updates each truck through the pipeline (current reading + sensors)', () => {
    const event = telemetryEvent();
    const trucks = applyTelemetryEvent(loadedFleet(), event, event.timestamp);
    for (const reading of event.readings) {
      expect(trucks[reading.truckId]?.telemetry?.current.timestamp).toBe(reading.timestamp);
      expect(trucks[reading.truckId]?.telemetry?.sensors['speed']).toBeDefined();
    }
  });

  it('live status comes from the newest reading, not the older snapshot', () => {
    const event = telemetryEvent();
    const reading = event.readings[0];
    if (reading === undefined) throw new Error('no reading');
    const changed: SseEvent = { ...event, readings: [{ ...reading, status: 'idle', timestamp: event.timestamp + 2000 }] };
    const trucks = applyTelemetryEvent(loadedFleet(), changed, event.timestamp + 2000);
    const truck = trucks[reading.truckId];
    if (truck === undefined) throw new Error('missing truck');
    expect(truckStatus(truck)).toBe('idle');
  });

  it('a GPS batch fills the path but does not move the marker (QUIRK #1)', () => {
    const batch = sse(batchFixture);
    if (batch.type !== 'gps_batch') throw new Error('not a batch');
    const template = batch.readings[0];
    if (template === undefined) throw new Error('empty batch');
    const newest = Math.max(...batch.readings.map((reading) => reading.timestamp));
    // Live data newer than every batch reading.
    const liveReading = { ...template, _batch: undefined, timestamp: newest + 2000 };
    const live = applyTelemetryEvent(
      loadedFleet(),
      { type: 'telemetry', timestamp: newest + 2000, readings: [liveReading] },
      newest + 2000,
    );
    const before = live[batch.truckId]?.telemetry;
    const after = applyTelemetryEvent(live, batch, newest + 2000)[batch.truckId]?.telemetry;
    expect(after?.current).toEqual(before?.current);
    expect(after?.path.length).toBeGreaterThan(before?.path.length ?? 0);
  });

  it('a reading for an unknown truck creates it (SSE before snapshot)', () => {
    const event = telemetryEvent();
    const trucks = applyTelemetryEvent({}, event, event.timestamp);
    expect(Object.keys(trucks)).toHaveLength(event.readings.length);
  });

  it('a heartbeat changes nothing and returns the SAME object (no redraw)', () => {
    const trucks = loadedFleet();
    expect(applyTelemetryEvent(trucks, sse(heartbeatFixture), Date.now())).toBe(trucks);
  });

  it('replaying the same telemetry event returns the SAME object (duplicates change nothing)', () => {
    const event = telemetryEvent();
    const once = applyTelemetryEvent(loadedFleet(), event, event.timestamp);
    expect(applyTelemetryEvent(once, event, event.timestamp)).toBe(once);
  });
});
