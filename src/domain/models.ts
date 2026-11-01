// Core entities of the fleet domain: trucks, telemetry readings, routes, alerts.
// Each entity is a Zod schema (runtime validator) plus a TS type inferred from it — one source of truth.
// Transport validates server payloads against these at the boundary; everything downstream trusts the types.
// Shapes are taken from server.js and verified against the captured fixtures (tests/domain/schemas.test.ts).
import { z } from 'zod';
import { DEFAULT_VEHICLE_TYPE } from './vehicles';

export const TruckStatusSchema = z.enum(['active', 'idle', 'maintenance']);
export type TruckStatus = z.infer<typeof TruckStatusSchema>;

export const LocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type Location = z.infer<typeof LocationSchema>;

// One sensor snapshot for one truck. Used by both normal `telemetry` events and `gps_batch` events.
// Values are raw sensor output — they may be wrong (speed 999, fuel 0). Filtering happens in domain logic, not here.
export const TelemetryReadingSchema = z.object({
  truckId: z.string(),
  location: LocationSchema,
  speed: z.number(),
  heading: z.number(),
  fuel: z.number(),
  engineTemp: z.number(),
  status: TruckStatusSchema,
  timestamp: z.number(),
  // QUIRK #5: set when the server deliberately sent an older reading. Debug hint only — we must not rely on it.
  _reordered: z.boolean().optional(),
  // QUIRK #1: present on readings that arrived inside a gps_batch.
  _batch: z.boolean().optional(),
  _batchIndex: z.number().optional(),
  _batchTotal: z.number().optional(),
});
export type TelemetryReading = z.infer<typeof TelemetryReadingSchema>;

// A truck as returned by GET /api/fleet.
export const FleetTruckSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: TruckStatusSchema,
  location: LocationSchema,
  speed: z.number(),
  heading: z.number(),
  fuel: z.number(),
  engineTemp: z.number(),
  currentRouteId: z.string().nullable(),
  _version: z.number(),
  // Not sent by the mock server today → default. A real backend would send it (from its vehicle DB).
  vehicleType: z.string().default(DEFAULT_VEHICLE_TYPE),
});
export type FleetTruck = z.infer<typeof FleetTruckSchema>;

// GET /api/fleet/:truckId returns more fields. Mileage exists only here (not in SSE or /api/fleet).
export const TruckDetailSchema = FleetTruckSchema.extend({
  mileage: z.number(),
  lastUpdate: z.number(),
});
export type TruckDetail = z.infer<typeof TruckDetailSchema>;

// The server accepts ANY status/priority string. We validate strictly: a value outside these lists
// means something we don't understand, and the event is rejected rather than shown wrong.
export const RouteStatusSchema = z.enum(['assigned', 'in-progress', 'completed', 'cancelled']);
export type RouteStatus = z.infer<typeof RouteStatusSchema>;

export const RoutePrioritySchema = z.enum(['low', 'normal', 'high']);
export type RoutePriority = z.infer<typeof RoutePrioritySchema>;

export const RouteSchema = z.object({
  id: z.string(),
  truckId: z.string(),
  destination: z.string(),
  priority: RoutePrioritySchema,
  notes: z.string(),
  status: RouteStatusSchema,
  assignedBy: z.string(),
  assignedAt: z.number(),
  // QUIRK #4: optimistic-locking version. Sent back as If-Match on PATCH.
  _version: z.number(),
  // Set only after the matching action happened.
  lastModifiedBy: z.string().optional(),
  lastModifiedAt: z.number().optional(),
  reassignedBy: z.string().optional(),
  reassignedAt: z.number().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertSchema = z.object({
  id: z.string(),
  truckId: z.string(),
  message: z.string(),
  severity: AlertSeveritySchema,
  // Optional: the alert endpoint does not enforce X-Dispatcher-Id, so the server may omit it.
  sentBy: z.string().optional(),
  timestamp: z.number(),
  acknowledged: z.boolean(),
});
export type Alert = z.infer<typeof AlertSchema>;
