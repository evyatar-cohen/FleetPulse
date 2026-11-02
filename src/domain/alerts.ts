// Alerts dispatchers send to trucks: input validation before sending, and the bounded list of alerts seen on the
// WebSocket (`truck_alert`, broadcast to every dispatcher — including the sender). Pure functions.
import type { Alert, AlertSeverity } from './models';
import { err, ok, type Result } from './result';

export const ALERT_MESSAGE_MIN_LENGTH: number = 3;
export const ALERT_MESSAGE_MAX_LENGTH: number = 200;
export const MAX_ALERTS: number = 50;

export interface AlertDraft {
  message: string;
  severity: AlertSeverity;
}

// Critical alerts interrupt a driver — ask for confirmation first.
export function alertNeedsConfirmation(severity: AlertSeverity): boolean {
  return severity === 'critical';
}

export function validateAlert(draft: AlertDraft): Result<AlertDraft, string> {
  const message = draft.message.trim();
  if (message.length < ALERT_MESSAGE_MIN_LENGTH) {
    return err(`Message must be at least ${ALERT_MESSAGE_MIN_LENGTH} characters`);
  }
  if (message.length > ALERT_MESSAGE_MAX_LENGTH) {
    return err(`Message must be at most ${ALERT_MESSAGE_MAX_LENGTH} characters`);
  }
  return ok({ message, severity: draft.severity });
}

// Newest last; duplicates (same id) ignored; bounded. Same array if nothing changed.
export function addAlert(alerts: readonly Alert[], alert: Alert): readonly Alert[] {
  if (alerts.some((existing) => existing.id === alert.id)) return alerts;
  const next = [...alerts, alert];
  return next.length > MAX_ALERTS ? next.slice(next.length - MAX_ALERTS) : next;
}
