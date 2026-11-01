// Checks that our Zod schemas match what the real server sends (fixtures captured in Phase 0),
// and that they reject malformed payloads. If the server shape and our types drift apart, this fails.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ErrorBodySchema,
  FleetResponseSchema,
  RouteConflictBodySchema,
  RoutesResponseSchema,
  TruckAssignedConflictBodySchema,
} from '../../src/domain/api';
import { SseEventSchema, WsServerMessageSchema } from '../../src/domain/events';
import {
  AlertSchema,
  RouteSchema,
  TelemetryReadingSchema,
  TruckDetailSchema,
} from '../../src/domain/models';

// Vite feature: loads every fixture file at import time into { path: parsedJson }.
const fixtureFiles = import.meta.glob<unknown>('../../fixtures/**/*.json', { eager: true, import: 'default' });

function loadFixture(relativePath: string): unknown {
  const data = fixtureFiles[`../../fixtures/${relativePath}`];
  if (data === undefined) {
    throw new Error(`Missing fixture: ${relativePath}`);
  }
  return data;
}

// The capture script wraps REST responses as { status, retryAfter, body }.
const RestFixtureSchema = z.object({
  status: z.number(),
  retryAfter: z.string().nullable(),
  body: z.unknown(),
});

function loadRestBody(relativePath: string): unknown {
  return RestFixtureSchema.parse(loadFixture(relativePath)).body;
}

// Fails with Zod's readable error list instead of a bare "expected true".
function expectValid(schema: z.ZodType, data: unknown): void {
  const result = schema.safeParse(data);
  expect(result.error?.issues).toBeUndefined();
}

describe('SSE fixtures match SseEventSchema', () => {
  const files = ['connected', 'heartbeat', 'telemetry', 'telemetry_reordered', 'gps_batch'];
  it.each(files)('sse/%s.json', (name) => {
    expectValid(SseEventSchema, loadFixture(`sse/${name}.json`));
  });

  // Sequences hold a truck's readings around an anomaly: telemetry entries carry one `reading`,
  // gps_batch entries are whole events.
  const SequenceEntrySchema = z.union([
    z.object({ type: z.literal('telemetry'), reading: TelemetryReadingSchema }),
    SseEventSchema,
  ]);
  const sequences = ['gps_batch_context', 'speed_stuck_sequence', 'fuel_glitch_sequence'];
  it.each(sequences)('sse/%s.json', (name) => {
    expectValid(z.array(SequenceEntrySchema), loadFixture(`sse/${name}.json`));
  });
});

describe('WebSocket fixtures match WsServerMessageSchema', () => {
  const files = [
    'registered', 'pong', 'error', 'dispatcher_joined', 'dispatcher_left', 'dispatcher_viewing',
    'route_assigned', 'route_updated', 'route_reassigned', 'truck_alert', 'fleet_reset',
  ];
  it.each(files)('ws/%s.json', (name) => {
    expectValid(WsServerMessageSchema, loadFixture(`ws/${name}.json`));
  });

  it('ws/ghost_reconnect_sequence.json', () => {
    const GhostSchema = z.object({ observed: z.array(z.object({ msg: WsServerMessageSchema })) });
    expectValid(GhostSchema, loadFixture('ws/ghost_reconnect_sequence.json'));
  });
});

describe('REST fixtures match their response schemas', () => {
  const cases: Array<[string, z.ZodType]> = [
    ['fleet_200', FleetResponseSchema],
    ['truck_detail', TruckDetailSchema],
    ['routes', RoutesResponseSchema],
    ['route_create_201', RouteSchema],
    ['route_patch_200', RouteSchema],
    ['route_reassign_200', RouteSchema],
    ['alert_201', AlertSchema],
    ['fleet_503', ErrorBodySchema],
    ['route_create_401', ErrorBodySchema],
    ['route_create_409', TruckAssignedConflictBodySchema],
    ['route_patch_409_immediate', RouteConflictBodySchema],
    ['route_patch_409_delayed', RouteConflictBodySchema],
  ];
  it.each(cases)('rest/%s.json', (name, schema) => {
    expectValid(schema, loadRestBody(`rest/${name}.json`));
  });

  it('the delayed 409 does not say who made the change (QUIRK #8)', () => {
    const body = RouteConflictBodySchema.parse(loadRestBody('rest/route_patch_409_delayed.json'));
    expect(body.lastModifiedBy).toBeUndefined();
  });
});

describe('schemas reject malformed payloads', () => {
  function firstTelemetryReading(): z.infer<typeof TelemetryReadingSchema> {
    const event = SseEventSchema.parse(loadFixture('sse/telemetry.json'));
    if (event.type !== 'telemetry') throw new Error('fixture is not a telemetry event');
    const reading = event.readings[0];
    if (reading === undefined) throw new Error('fixture has no readings');
    return reading;
  }

  it('rejects a reading whose speed is not a number', () => {
    const result = TelemetryReadingSchema.safeParse({ ...firstTelemetryReading(), speed: '999' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown SSE event type', () => {
    const result = SseEventSchema.safeParse({ type: 'teleport', timestamp: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a route with a status outside the allowed list', () => {
    const route = RouteSchema.parse(loadRestBody('rest/route_create_201.json'));
    const result = RouteSchema.safeParse({ ...route, status: 'banana' });
    expect(result.success).toBe(false);
  });

  it('keeps quirk metadata fields on readings (not stripped)', () => {
    const batch = SseEventSchema.parse(loadFixture('sse/gps_batch.json'));
    if (batch.type !== 'gps_batch') throw new Error('fixture is not a gps_batch');
    expect(batch.readings[0]?._batch).toBe(true);
  });
});
