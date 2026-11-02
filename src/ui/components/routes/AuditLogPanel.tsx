// Route history (audit log): who changed which route, how and when — newest first. Built client-side (D40): live WS
// events plus older history seeded from the routes snapshot (marked "from snapshot").
import type { ReactElement } from 'react';
import { useFleetStore } from '../../../store/fleetStore';
import { selectTrucks } from '../../selectors';
import { useThrottledStore } from '../../useThrottledStore';
import { formatTime } from '../../format';
import { describeAuditAction, dispatcherLabel } from '../../routeFormat';

export function AuditLogPanel(): ReactElement {
  const auditLog = useFleetStore((state) => state.auditLog);
  // Truck names/route ids only — read through the 1 s throttle so telemetry doesn't redraw this every 2 s.
  const trucks = useThrottledStore(selectTrucks);
  const myId = useFleetStore((state) => state.dispatcherId);
  const newestFirst = [...auditLog].reverse();

  return (
    <section className="panel">
      <h2>Route history</h2>
      {newestFirst.length === 0 ? (
        <p className="muted">No route changes yet.</p>
      ) : (
        <ul className="audit-log">
          {newestFirst.map((entry) => (
            <li key={entry.key}>
              <span className="muted">{formatTime(entry.at)}</span> <strong>{dispatcherLabel(entry.by, myId)}</strong>{' '}
              {entry.routeId}: {describeAuditAction(entry.action, trucks)}
              {entry.source === 'snapshot' && <span className="muted"> (from snapshot)</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
