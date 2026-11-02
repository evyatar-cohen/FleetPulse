// REST client: the only place the app makes HTTP calls to the mock server.
// Data flow: store/UI → RestClient method → fetch → status check → Zod validation → Result (data or typed error).
// Adds X-Dispatcher-Id to every request and If-Match to route updates.
// Deliberately NOT here: retry and circuit breaker (wrappers, see retry.ts / circuitBreaker.ts) and business rules
// (domain/). Writes are never retried automatically.
import type { z } from 'zod';
import {
  ErrorBodySchema,
  FleetResponseSchema,
  RouteConflictBodySchema,
  RoutesResponseSchema,
  TruckAssignedConflictBodySchema,
  type FleetResponse,
  type RouteConflictBody,
  type RoutesResponse,
  type TruckAssignedConflictBody,
} from '../domain/api';
import {
  AlertSchema,
  RouteSchema,
  TruckDetailSchema,
  type Alert,
  type AlertSeverity,
  type Route,
  type RoutePriority,
  type RouteStatus,
  type TruckDetail,
} from '../domain/models';
import { err, ok, type Result } from '../domain/result';

// A hung request must not wait forever.
export const REQUEST_TIMEOUT_MS: number = 10_000;

// Same shape as the browser's fetch — injected so tests can pass a fake (dependency injection).
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type ApiError =
  | { kind: 'not_registered' } // a write before we got our dispatcher id from the WebSocket
  | { kind: 'network'; message: string } // no answer at all (server down, connection lost)
  | { kind: 'timeout' }
  | { kind: 'unavailable'; retryAfterMs: number | null } // 503 (QUIRK #7)
  | { kind: 'circuit_open'; retryAtMs: number } // circuit breaker refused the call; probe allowed at retryAtMs
  | { kind: 'version_conflict'; body: RouteConflictBody } // PATCH 409 (QUIRK #4 / #8)
  | { kind: 'truck_assigned'; body: TruckAssignedConflictBody } // POST /routes 409
  | { kind: 'target_truck_busy'; message: string } // reassign 409
  | { kind: 'unauthorized'; message: string } // 401
  | { kind: 'not_found'; message: string } // 404
  | { kind: 'bad_request'; message: string } // 400
  | { kind: 'invalid_response'; status: number; message: string } // body didn't match our schema
  | { kind: 'http'; status: number; message: string }; // any other status

export type ApiResult<T> = Result<T, ApiError>;

export interface NewRouteInput {
  truckId: string;
  destination: string;
  priority?: RoutePriority;
  notes?: string;
}

export interface RouteChanges {
  status?: RouteStatus;
  notes?: string;
  priority?: RoutePriority;
}

export interface AlertInput {
  message: string;
  severity: AlertSeverity;
}

interface RequestOptions {
  body?: unknown;
  extraHeaders?: Record<string, string>;
  requiresDispatcher?: boolean;
  // How to read a 409 body for this endpoint (each endpoint's 409 means something different).
  parseConflict?: (body: unknown) => ApiError;
}

interface RestClientOptions {
  fetch: FetchFn;
  // '' = same origin (the Vite dev proxy forwards /api to the mock server).
  baseUrl?: string;
}

export class RestClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private dispatcherId: string | null = null;

  constructor(options: RestClientOptions) {
    this.fetchFn = options.fetch;
    this.baseUrl = options.baseUrl ?? '';
  }

  // Called once the WebSocket `registered` message gives us our id.
  setDispatcherId(dispatcherId: string): void {
    this.dispatcherId = dispatcherId;
  }

  getFleet(): Promise<ApiResult<FleetResponse>> {
    return this.request('GET', '/api/fleet', FleetResponseSchema);
  }

  // The only endpoint with mileage.
  getTruckDetail(truckId: string): Promise<ApiResult<TruckDetail>> {
    return this.request('GET', `/api/fleet/${encodeURIComponent(truckId)}`, TruckDetailSchema);
  }

  getRoutes(): Promise<ApiResult<RoutesResponse>> {
    return this.request('GET', '/api/routes', RoutesResponseSchema);
  }

  createRoute(input: NewRouteInput): Promise<ApiResult<Route>> {
    return this.request('POST', '/api/routes', RouteSchema, {
      body: input,
      requiresDispatcher: true,
      parseConflict: (body) => conflictError(TruckAssignedConflictBodySchema, body, (parsed) => ({
        kind: 'truck_assigned',
        body: parsed,
      })),
    });
  }

  // QUIRK #4: always send If-Match — the server only checks the version when the header is present.
  updateRoute(routeId: string, changes: RouteChanges, expectedVersion: number): Promise<ApiResult<Route>> {
    return this.request('PATCH', `/api/routes/${encodeURIComponent(routeId)}`, RouteSchema, {
      body: changes,
      extraHeaders: { 'If-Match': String(expectedVersion) },
      requiresDispatcher: true,
      parseConflict: (body) => conflictError(RouteConflictBodySchema, body, (parsed) => ({
        kind: 'version_conflict',
        body: parsed,
      })),
    });
  }

  // No version check on the server for reassign — races are detected from WebSocket events instead.
  reassignRoute(routeId: string, newTruckId: string): Promise<ApiResult<Route>> {
    return this.request('PUT', `/api/routes/${encodeURIComponent(routeId)}/reassign`, RouteSchema, {
      body: { newTruckId },
      requiresDispatcher: true,
      parseConflict: (body) => conflictError(ErrorBodySchema, body, (parsed) => ({
        kind: 'target_truck_busy',
        message: parsed.error,
      })),
    });
  }

  // The server doesn't require X-Dispatcher-Id here, but we send it anyway so the alert records who sent it.
  sendAlert(truckId: string, input: AlertInput): Promise<ApiResult<Alert>> {
    return this.request('POST', `/api/fleet/${encodeURIComponent(truckId)}/alert`, AlertSchema, {
      body: input,
      requiresDispatcher: true,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    successSchema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    if (options.requiresDispatcher === true && this.dispatcherId === null) {
      return err({ kind: 'not_registered' });
    }

    const response = await this.send(method, path, options);
    if (!response.ok) {
      return response;
    }
    const httpResponse = response.data;

    const body = await readJson(httpResponse);

    if (httpResponse.ok) {
      if (!body.ok) {
        return err({ kind: 'invalid_response', status: httpResponse.status, message: 'Response is not valid JSON' });
      }
      return parseSuccess(successSchema, body.data, httpResponse.status);
    }
    // Error status: the status decides the error kind. The body may not be JSON (e.g. a proxy's HTML 503 page) —
    // that must still count as `unavailable` so retry and the circuit breaker work.
    const errorBody = body.ok ? body.data : null;
    return err(toApiError(httpResponse, errorBody, options));
  }

  // Sends the request with a timeout. Only "no answer at all" is an error here; any HTTP status is a response.
  private async send(method: string, path: string, options: RequestOptions): Promise<ApiResult<Response>> {
    const headers: Record<string, string> = { ...options.extraHeaders };
    if (this.dispatcherId !== null) {
      headers['X-Dispatcher-Id'] = this.dispatcherId;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      return ok(response);
    } catch (error) {
      if (controller.signal.aborted) {
        return err({ kind: 'timeout' });
      }
      return err({ kind: 'network', message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------- helpers (pure) ----------

async function readJson(response: Response): Promise<Result<unknown, null>> {
  try {
    return ok(await response.json());
  } catch {
    return err(null);
  }
}

// Success body: validate with the endpoint's schema.
function parseSuccess<T>(schema: z.ZodType<T>, data: unknown, status: number): ApiResult<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return err({ kind: 'invalid_response', status, message: parsed.error.message });
  }
  return ok(parsed.data);
}

// 409 body: validate with the endpoint's conflict schema, then build that endpoint's error.
function conflictError<S>(schema: z.ZodType<S>, body: unknown, toError: (parsed: S) => ApiError): ApiError {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'invalid_response', status: 409, message: parsed.error.message };
  }
  return toError(parsed.data);
}

function errorMessage(body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error : 'Unknown error';
}

// QUIRK #7: Retry-After is in seconds (the server sends "3"). Anything unreadable → null (caller decides).
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function toApiError(response: Response, body: unknown, options: RequestOptions): ApiError {
  switch (response.status) {
    case 400:
      return { kind: 'bad_request', message: errorMessage(body) };
    case 401:
      return { kind: 'unauthorized', message: errorMessage(body) };
    case 404:
      return { kind: 'not_found', message: errorMessage(body) };
    case 409:
      if (options.parseConflict !== undefined) {
        return options.parseConflict(body);
      }
      return { kind: 'http', status: 409, message: errorMessage(body) };
    case 503:
      return { kind: 'unavailable', retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')) };
    default:
      return { kind: 'http', status: response.status, message: errorMessage(body) };
  }
}
