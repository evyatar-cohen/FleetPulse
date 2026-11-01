// Messages that arrive over the two live channels: SSE (telemetry) and WebSocket (presence + routes).
// Each channel is a discriminated union on the `type` field: checking `msg.type` tells TypeScript
// exactly which fields exist. Incoming messages get Zod schemas (untrusted input);
// outgoing WS messages are plain TS types (we build them ourselves, nothing to validate).
import { z } from 'zod';
import { AlertSchema, RouteSchema, TelemetryReadingSchema } from './models';

// ---------- SSE: GET /api/telemetry/stream ----------

const SseConnectedSchema = z.object({
  type: z.literal('connected'),
  truckCount: z.number(),
  timestamp: z.number(),
});

const SseHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number(),
});

// Normal tick: one reading per truck, every 2 s.
const SseTelemetrySchema = z.object({
  type: z.literal('telemetry'),
  readings: z.array(TelemetryReadingSchema),
  timestamp: z.number(),
});

// QUIRK #1: 10–30 old readings for one truck, sent at once (oldest first).
const SseGpsBatchSchema = z.object({
  type: z.literal('gps_batch'),
  truckId: z.string(),
  readings: z.array(TelemetryReadingSchema),
});

export const SseEventSchema = z.discriminatedUnion('type', [
  SseConnectedSchema,
  SseHeartbeatSchema,
  SseTelemetrySchema,
  SseGpsBatchSchema,
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

// ---------- WebSocket: server → client ----------

const WsRegisteredSchema = z.object({
  type: z.literal('registered'),
  dispatcherId: z.string(),
});

const WsPongSchema = z.object({
  type: z.literal('pong'),
  timestamp: z.number(),
});

const WsErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

const WsDispatcherJoinedSchema = z.object({
  type: z.literal('dispatcher_joined'),
  dispatcherId: z.string(),
  name: z.string(),
  timestamp: z.number(),
  activeDispatchers: z.number(),
});

// QUIRK #6: may arrive ~10 s late — even after the same id reconnected.
const WsDispatcherLeftSchema = z.object({
  type: z.literal('dispatcher_left'),
  dispatcherId: z.string(),
  timestamp: z.number(),
  activeDispatchers: z.number(),
});

// dispatcherId is null when the sender sent viewing_truck before registering.
const WsDispatcherViewingSchema = z.object({
  type: z.literal('dispatcher_viewing'),
  dispatcherId: z.string().nullable(),
  truckId: z.string(),
  timestamp: z.number(),
});

const WsRouteAssignedSchema = z.object({
  type: z.literal('route_assigned'),
  route: RouteSchema,
  truckId: z.string(),
  assignedBy: z.string(),
  truckVersion: z.number(),
  timestamp: z.number(),
});

const WsRouteUpdatedSchema = z.object({
  type: z.literal('route_updated'),
  route: RouteSchema,
  updatedBy: z.string(),
  timestamp: z.number(),
});

const WsRouteReassignedSchema = z.object({
  type: z.literal('route_reassigned'),
  route: RouteSchema,
  // Omitted by the server if the old truck no longer exists.
  oldTruckId: z.string().optional(),
  newTruckId: z.string(),
  reassignedBy: z.string(),
  timestamp: z.number(),
});

const WsTruckAlertSchema = z.object({
  type: z.literal('truck_alert'),
  alert: AlertSchema,
});

const WsFleetResetSchema = z.object({
  type: z.literal('fleet_reset'),
  timestamp: z.number(),
});

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsRegisteredSchema,
  WsPongSchema,
  WsErrorSchema,
  WsDispatcherJoinedSchema,
  WsDispatcherLeftSchema,
  WsDispatcherViewingSchema,
  WsRouteAssignedSchema,
  WsRouteUpdatedSchema,
  WsRouteReassignedSchema,
  WsTruckAlertSchema,
  WsFleetResetSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

// ---------- WebSocket: client → server ----------

export type WsClientMessage =
  | { type: 'register_dispatcher'; name: string; dispatcherId?: string }
  | { type: 'ping' }
  | { type: 'viewing_truck'; truckId: string };
