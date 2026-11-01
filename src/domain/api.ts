// Response bodies of the REST endpoints, including the error bodies we must react to.
// Success bodies reuse the entity schemas from models.ts.
import { z } from 'zod';
import { FleetTruckSchema, RouteSchema } from './models';

// GET /api/fleet
export const FleetResponseSchema = z.object({
  fleet: z.array(FleetTruckSchema),
  timestamp: z.number(),
});
export type FleetResponse = z.infer<typeof FleetResponseSchema>;

// GET /api/routes
export const RoutesResponseSchema = z.object({
  routes: z.array(RouteSchema),
  timestamp: z.number(),
});
export type RoutesResponse = z.infer<typeof RoutesResponseSchema>;

// Every error response has at least `error`. (401, 400, 404, 503)
export const ErrorBodySchema = z.object({
  error: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// PATCH /api/routes/:id → 409. Two variants from the server:
//  - immediate (QUIRK #4): includes yourVersion + lastModifiedBy
//  - delayed  (QUIRK #8): only currentVersion — "who" must come from WS events or a refetch
export const RouteConflictBodySchema = z.object({
  error: z.string(),
  currentVersion: z.number(),
  yourVersion: z.number().optional(),
  lastModifiedBy: z.string().optional(),
});
export type RouteConflictBody = z.infer<typeof RouteConflictBodySchema>;

// POST /api/routes → 409 when the truck already has a route.
export const TruckAssignedConflictBodySchema = z.object({
  error: z.string(),
  currentRouteId: z.string(),
  assignedBy: z.string().optional(),
});
export type TruckAssignedConflictBody = z.infer<typeof TruckAssignedConflictBodySchema>;
