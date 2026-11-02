// Shown when our route update lost an optimistic-lock race (409): WHO changed the route, WHAT they changed, the route
// as it is now vs. what we wanted, and the choices: keep theirs (default) / apply mine (only if still possible).
import type { ReactElement } from 'react';
import type { Conflict } from '../../../app/routeActions';
import type { AttemptedChange } from '../../../domain/conflicts';
import { useFleetStore } from '../../../store/fleetStore';
import { selectTrucks } from '../../selectors';
import { useThrottledStore } from '../../useThrottledStore';
import { describeAuditAction, dispatcherLabel, truckLabel } from '../../routeFormat';
import { Modal } from '../Modal';

interface ConflictDialogProps {
  conflict: Conflict;
  attempt: AttemptedChange;
  onKeepTheirs: () => void;
  onApplyMine: () => void;
}

export function ConflictDialog({ conflict, attempt, onKeepTheirs, onApplyMine }: ConflictDialogProps): ReactElement {
  // Truck names/route ids only — read through the 1 s throttle so telemetry doesn't redraw this every 2 s.
  const trucks = useThrottledStore(selectTrucks);
  const myId = useFleetStore((state) => state.dispatcherId);
  const who = dispatcherLabel(conflict.who, myId);
  const what = conflict.theirChange === null ? 'changed this route' : describeAuditAction(conflict.theirChange, trucks);
  const current = conflict.currentRoute;

  return (
    <Modal title="Someone else changed this route first" onClose={onKeepTheirs}>
      <p>
        <strong>{who}</strong> {what} while your change was being saved. Your change was <strong>not</strong> applied.
      </p>
      <table className="conflict-table">
        <thead>
          <tr>
            <th />
            <th>Now (theirs)</th>
            <th>Yours</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Status</td>
            <td>{current?.status ?? 'unknown'}</td>
            <td>{attempt.changes.status ?? '—'}</td>
          </tr>
          <tr>
            <td>Truck</td>
            <td>{current === undefined ? 'unknown' : truckLabel(current.truckId, trucks)}</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
      {!conflict.canApplyMine && (
        <p className="muted">Your change can't be applied on top of theirs (for example, the route is already finished).</p>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onKeepTheirs} autoFocus>
          Keep theirs
        </button>
        {conflict.canApplyMine && (
          <button type="button" onClick={onApplyMine}>
            Apply mine anyway
          </button>
        )}
      </div>
    </Modal>
  );
}
