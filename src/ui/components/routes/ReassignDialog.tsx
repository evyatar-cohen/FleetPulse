// Reassign a route to another truck. The server has NO version check here (D44), so the dialog remembers the route
// version when it opened; if the route changed meanwhile, it warns (who/what) and asks to confirm again.
import { useState, type ReactElement } from 'react';
import type { ActionOutcome, RouteActions } from '../../../app/routeActions';
import type { AuditAction } from '../../../domain/auditLog';
import type { Route } from '../../../domain/models';
import { whyTruckCannotTakeRoute } from '../../../domain/routeRules';
import { useFleetStore } from '../../../store/fleetStore';
import { useThrottledStore } from '../../useThrottledStore';
import { describeAuditAction, dispatcherLabel, truckLabel } from '../../routeFormat';
import { selectTrucks, sortedTrucks } from '../../selectors';
import { Modal } from '../Modal';

interface ReassignDialogProps {
  route: Route;
  actions: RouteActions;
  onDone: (outcome: ActionOutcome, targetTruckId: string) => void;
  onClose: () => void;
}

function reassignButtonLabel(saving: boolean, warned: boolean, targetName: string | null): string {
  if (saving) return '⏳ Saving…';
  if (warned) return 'Reassign anyway';
  if (targetName === null) return 'Reassign';
  return `Reassign to ${targetName}`;
}

export function ReassignDialog({ route, actions, onDone, onClose }: ReassignDialogProps): ReactElement {
  // Truck names/route ids only — read through the 1 s throttle so telemetry doesn't redraw this every 2 s.
  const trucks = useThrottledStore(selectTrucks);
  const myId = useFleetStore((state) => state.dispatcherId);
  const names = useFleetStore((state) => state.dispatcherNames);
  // The version we based our decision on — fixed when the dialog opens.
  const [openedVersion] = useState(route._version);
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedBy, setChangedBy] = useState<{ by: string | null; change: AuditAction | null } | null>(null);

  async function submit(confirmedDespiteChange: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    const outcome = await actions.reassign(route.id, target, openedVersion, confirmedDespiteChange);
    setSaving(false);
    if (outcome.kind === 'changed_since_opened') {
      setChangedBy({ by: outcome.by, change: outcome.change });
      return;
    }
    if (outcome.kind === 'invalid') {
      setError(typeof outcome.errors === 'string' ? outcome.errors : 'Invalid choice');
      return;
    }
    if (outcome.kind === 'error') {
      setError(outcome.message);
      return;
    }
    onDone(outcome, target);
  }

  return (
    <Modal title={`Reassign ${route.id} ("${route.destination}")`} onClose={onClose}>
      <p>
        Currently on <strong>{truckLabel(route.truckId, trucks)}</strong>. Move it to:
      </p>
      <select value={target} onChange={(event) => setTarget(event.target.value)} autoFocus>
        <option value="">Choose a truck…</option>
        {sortedTrucks(trucks)
          .filter((truck) => truck.id !== route.truckId)
          .map((truck) => {
            const reason = whyTruckCannotTakeRoute(truck);
            return (
              <option key={truck.id} value={truck.id} disabled={reason !== null}>
                {truck.name}
                {reason !== null ? ` — ${reason}` : ''}
              </option>
            );
          })}
      </select>
      {changedBy !== null && (
        <div className="banner banner-warn">
          ⚠ {dispatcherLabel(changedBy.by, myId, names)}{' '}
          {changedBy.change === null ? 'changed this route' : describeAuditAction(changedBy.change, trucks)} since you opened
          this dialog. Check it before continuing.
        </div>
      )}
      {error !== null && <p className="field-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={saving || target === ''}
          onClick={() => void submit(changedBy !== null)}
        >
          {reassignButtonLabel(saving, changedBy !== null, target === '' ? null : truckLabel(target, trucks))}
        </button>
      </div>
    </Modal>
  );
}
