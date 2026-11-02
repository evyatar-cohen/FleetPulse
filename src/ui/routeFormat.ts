// Pure display helpers for routes, conflicts and the audit log: turn ids and actions into the sentences dispatchers read.
import type { AuditAction, FieldChange } from '../domain/auditLog';
import type { Trucks } from '../domain/fleet';
import type { RouteStatus } from '../domain/models';

// Until presence (Phase 6) gives names, show "You" for us and the dispatcher id for others.
export function dispatcherLabel(dispatcherId: string | null, myDispatcherId: string | null): string {
  if (dispatcherId === null) return 'another dispatcher';
  if (dispatcherId === myDispatcherId) return 'You';
  return dispatcherId;
}

export function truckLabel(truckId: string | null, trucks: Trucks): string {
  if (truckId === null) return 'an unknown truck';
  return trucks[truckId]?.name ?? truckId;
}

// Button text for moving a route to a status.
const STATUS_ACTION_LABELS: Readonly<Record<RouteStatus, string>> = {
  assigned: 'Assign',
  'in-progress': 'Start',
  completed: 'Complete',
  cancelled: 'Cancel route',
};

export function statusActionLabel(status: RouteStatus): string {
  return STATUS_ACTION_LABELS[status];
}

// Final or work-moving actions ask for confirmation (D45); starting a route doesn't.
export function needsConfirmation(status: RouteStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

function describeChange<T extends string>(name: string, change: FieldChange<T>): string {
  return change.from === null ? `${name} → ${change.to}` : `${name} ${change.from} → ${change.to}`;
}

// "reassigned Truck Alpha → Truck Delta", "status assigned → in-progress", …
export function describeAuditAction(action: AuditAction, trucks: Trucks): string {
  if (action.kind === 'assigned') {
    const truck = action.truckId === null ? '' : ` to ${truckLabel(action.truckId, trucks)}`;
    return `assigned the route${truck} ("${action.destination}")`;
  }
  if (action.kind === 'reassigned') {
    const from = action.fromTruckId === null ? '' : `${truckLabel(action.fromTruckId, trucks)} → `;
    return `reassigned it ${from}${truckLabel(action.toTruckId, trucks)}`;
  }
  const parts: string[] = [];
  if (action.status !== undefined) parts.push(describeChange('status', action.status));
  if (action.priority !== undefined) parts.push(describeChange('priority', action.priority));
  if (action.notesChanged) parts.push('notes changed');
  return parts.length === 0 ? 'updated it' : `changed ${parts.join(', ')}`;
}
