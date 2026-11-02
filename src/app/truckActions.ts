// Truck actions for the detail panel: load the truck detail (mileage — not in SSE or /api/fleet) and send an alert.
// Data flow: UI → action → (validate) → REST → outcome. The sent alert itself comes back via the WS `truck_alert`
// broadcast (to every dispatcher), which the store records.
import { validateAlert, type AlertDraft } from '../domain/alerts';
import type { TruckDetail } from '../domain/models';
import type { ApiResult, RestClient } from '../transport/restClient';
import { withRetry } from '../transport/retry';

export type AlertOutcome =
  | { kind: 'sent' }
  | { kind: 'invalid'; message: string }
  // Network/timeout: the alert may or may not have been sent — never resent automatically (a driver would get it
  // twice); the dispatcher decides after checking the alerts list.
  | { kind: 'error'; message: string; retryable: boolean };

export interface TruckActions {
  loadDetail: (truckId: string) => Promise<ApiResult<TruckDetail>>;
  sendAlert: (truckId: string, draft: AlertDraft) => Promise<AlertOutcome>;
}

export function createTruckActions(rest: RestClient): TruckActions {
  return {
    // A read → safe to retry automatically.
    loadDetail: (truckId) => withRetry(() => rest.getTruckDetail(truckId)),

    async sendAlert(truckId, draft) {
      const valid = validateAlert(draft);
      if (!valid.ok) return { kind: 'invalid', message: valid.error };
      // ONE request: POST /alert is not idempotent (no automatic retry).
      const result = await rest.sendAlert(truckId, valid.data);
      if (result.ok) return { kind: 'sent' };
      const error = result.error;
      if (error.kind === 'network' || error.kind === 'timeout') {
        return { kind: 'error', message: 'No answer from the server — the alert may or may not have been sent.', retryable: true };
      }
      if (error.kind === 'not_registered') {
        return { kind: 'error', message: 'Still connecting to dispatch — try again in a moment.', retryable: true };
      }
      return { kind: 'error', message: `Could not send the alert (${error.kind}).`, retryable: false };
    },
  };
}
