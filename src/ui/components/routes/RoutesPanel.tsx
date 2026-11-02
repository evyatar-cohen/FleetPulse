// Routes panel: every route with its status, the allowed next actions only (routeRules), per-route "saving…",
// confirmation before critical actions (D45), the conflict dialog on a 409 (D42), the reassign dialog (D44), and a
// short watch after our reassign for a concurrent one by someone else.
import { useEffect, useState, type ReactElement } from 'react';
import type { ActionOutcome, Conflict, RouteActions } from '../../../app/routeActions';
import type { AttemptedChange } from '../../../domain/conflicts';
import type { Route, RouteStatus } from '../../../domain/models';
import { findConcurrentReassign, REASSIGN_RACE_WINDOW_MS } from '../../../domain/reassignRace';
import { allowedNextStatuses } from '../../../domain/routeRules';
import { useFleetStore } from '../../../store/fleetStore';
import { selectTrucks } from '../../selectors';
import { useThrottledStore } from '../../useThrottledStore';
import { dispatcherLabel, needsConfirmation, statusActionLabel, truckLabel } from '../../routeFormat';
import { ConfirmDialog } from '../Modal';
import { ConflictDialog } from './ConflictDialog';
import { NewRouteForm } from './NewRouteForm';
import { ReassignDialog } from './ReassignDialog';

interface PendingConfirm {
  route: Route;
  status: RouteStatus;
}

interface OpenConflict {
  conflict: Conflict;
  attempt: AttemptedChange;
}

// After our reassign: watch for someone else's reassign of the same route around the same time.
interface RaceWatch {
  routeId: string;
  at: number;
}

// Newest routes first; finished routes after active ones.
function sortRoutes(routes: readonly Route[]): Route[] {
  return [...routes].sort((a, b) => {
    const aDone = a.status === 'completed' || a.status === 'cancelled';
    const bDone = b.status === 'completed' || b.status === 'cancelled';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return b.assignedAt - a.assignedAt;
  });
}

export function RoutesPanel({ actions }: { actions: RouteActions }): ReactElement {
  const routes = useFleetStore((state) => state.routes);
  // Truck names/route ids only — read through the 1 s throttle so telemetry doesn't redraw this every 2 s.
  const trucks = useThrottledStore(selectTrucks);
  const auditLog = useFleetStore((state) => state.auditLog);
  const myId = useFleetStore((state) => state.dispatcherId);
  const names = useFleetStore((state) => state.dispatcherNames);

  const [saving, setSaving] = useState<Readonly<Record<string, boolean>>>({});
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [openConflict, setOpenConflict] = useState<OpenConflict | null>(null);
  const [reassigning, setReassigning] = useState<Route | null>(null);
  const [raceWatch, setRaceWatch] = useState<RaceWatch | null>(null);

  function setRouteMessage(routeId: string, message: string | null): void {
    setMessages((current) => {
      const next = { ...current };
      if (message === null) delete next[routeId];
      else next[routeId] = message;
      return next;
    });
  }

  function handleOutcome(routeId: string, outcome: ActionOutcome): void {
    if (outcome.kind === 'success') setRouteMessage(routeId, null);
    else if (outcome.kind === 'already_applied') setRouteMessage(routeId, '✓ Already done (your earlier attempt went through)');
    else if (outcome.kind === 'conflict') setOpenConflict({ conflict: outcome.conflict, attempt: outcome.attempt });
    else if (outcome.kind === 'invalid') setRouteMessage(routeId, typeof outcome.errors === 'string' ? outcome.errors : 'Invalid change');
    else if (outcome.kind === 'error') setRouteMessage(routeId, outcome.message);
  }

  async function runForRoute(routeId: string, action: () => Promise<ActionOutcome>): Promise<void> {
    setSaving((current) => ({ ...current, [routeId]: true }));
    setRouteMessage(routeId, null);
    const outcome = await action();
    setSaving((current) => ({ ...current, [routeId]: false }));
    handleOutcome(routeId, outcome);
  }

  function requestStatus(route: Route, status: RouteStatus): void {
    if (needsConfirmation(status)) {
      setConfirm({ route, status });
      return;
    }
    void runForRoute(route.id, () => actions.updateStatus(route.id, status));
  }

  // Concurrent-reassign watch: check the audit log as it changes, for a limited time.
  useEffect(() => {
    if (raceWatch === null || myId === null) return;
    const clash = findConcurrentReassign(auditLog, raceWatch.routeId, myId, raceWatch.at);
    if (clash !== null && clash.action.kind === 'reassigned') {
      setRouteMessage(
        raceWatch.routeId,
        `⚠ ${dispatcherLabel(clash.by, myId, names)} also reassigned this route at the same time — it's now on ${truckLabel(
          routes[raceWatch.routeId]?.truckId ?? null,
          trucks,
        )}.`,
      );
      setRaceWatch(null);
    }
  }, [auditLog, raceWatch, myId, names, routes, trucks]);

  useEffect(() => {
    if (raceWatch === null) return;
    const timer = setTimeout(() => setRaceWatch(null), REASSIGN_RACE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [raceWatch]);

  const sorted = sortRoutes(Object.values(routes));

  return (
    <section className="panel">
      <h2>Routes ({sorted.length})</h2>
      <NewRouteForm actions={actions} />
      <table className="routes-table">
        <thead>
          <tr>
            <th>Route</th>
            <th>Truck</th>
            <th>Destination</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Assigned by</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((route) => (
            <tr key={route.id}>
              <td>{route.id}</td>
              <td>{truckLabel(route.truckId, trucks)}</td>
              <td title={route.notes}>{route.destination}</td>
              <td>{route.priority}</td>
              <td>{route.status}</td>
              <td>{dispatcherLabel(route.assignedBy, myId, names)}</td>
              <td className="route-actions">
                {saving[route.id] === true ? (
                  <span>⏳ saving…</span>
                ) : (
                  <>
                    {allowedNextStatuses(route.status).map((status) => (
                      <button key={status} type="button" onClick={() => requestStatus(route, status)}>
                        {statusActionLabel(status)}
                      </button>
                    ))}
                    {route.status !== 'completed' && route.status !== 'cancelled' && (
                      <button type="button" onClick={() => setReassigning(route)}>
                        Reassign
                      </button>
                    )}
                  </>
                )}
                {messages[route.id] !== undefined && <div className="route-message">{messages[route.id]}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {confirm !== null && (
        <ConfirmDialog
          title={`${statusActionLabel(confirm.status)} ${confirm.route.id}?`}
          message={`"${confirm.route.destination}" on ${truckLabel(confirm.route.truckId, trucks)} will be marked ${confirm.status}. This can't be undone.`}
          confirmLabel={statusActionLabel(confirm.status)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { route, status } = confirm;
            setConfirm(null);
            void runForRoute(route.id, () => actions.updateStatus(route.id, status));
          }}
        />
      )}

      {openConflict !== null && (
        <ConflictDialog
          conflict={openConflict.conflict}
          attempt={openConflict.attempt}
          onKeepTheirs={() => setOpenConflict(null)}
          onApplyMine={() => {
            const { conflict, attempt } = openConflict;
            setOpenConflict(null);
            void runForRoute(attempt.routeId, () => actions.applyMine(attempt, conflict.currentVersion));
          }}
        />
      )}

      {reassigning !== null && (
        <ReassignDialog
          route={reassigning}
          actions={actions}
          onClose={() => setReassigning(null)}
          onDone={(outcome) => {
            const routeId = reassigning.id;
            setReassigning(null);
            handleOutcome(routeId, outcome);
            if (outcome.kind === 'success' && outcome.reassignedAt !== undefined) {
              setRaceWatch({ routeId, at: outcome.reassignedAt });
            }
          }}
        />
      )}
    </section>
  );
}
