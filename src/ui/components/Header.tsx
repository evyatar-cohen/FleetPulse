// Header: who I am, live-connection badges (SSE telemetry, WebSocket), who else is online, and the stale-data banners.
// Reads rarely-changing store slices directly (no throttling needed).
import type { ReactElement } from 'react';
import { useFleetStore } from '../../store/fleetStore';
import type { ConnectionStatus } from '../../transport/connection';
import { formatTime } from '../format';

const BADGES: Readonly<Record<ConnectionStatus, { icon: string; label: string; className: string }>> = {
  idle: { icon: '○', label: 'Not connected', className: 'badge-down' },
  connecting: { icon: '◐', label: 'Connecting…', className: 'badge-warn' },
  open: { icon: '●', label: 'Live', className: 'badge-ok' },
  reconnecting: { icon: '◐', label: 'Reconnecting…', className: 'badge-warn' },
  closed: { icon: '○', label: 'Offline', className: 'badge-down' },
};

function ConnectionBadge({ title, status }: { title: string; status: ConnectionStatus }): ReactElement {
  const badge = BADGES[status];
  return (
    <span className={`badge ${badge.className}`}>
      {title}: {badge.icon} {badge.label}
    </span>
  );
}

export function Header(): ReactElement {
  const dispatcherName = useFleetStore((state) => state.dispatcherName);
  const dispatcherId = useFleetStore((state) => state.dispatcherId);
  const sseStatus = useFleetStore((state) => state.sseStatus);
  const wsStatus = useFleetStore((state) => state.wsStatus);
  const fleetStale = useFleetStore((state) => state.fleetStale);
  const fleetFetchedAt = useFleetStore((state) => state.fleetFetchedAt);
  const presence = useFleetStore((state) => state.presence);
  const others = Object.values(presence).map((dispatcher) => dispatcher.name ?? dispatcher.id);

  return (
    <header>
      <div className="header-row">
        <h1>FleetPulse</h1>
        <span className="dispatcher">
          {dispatcherName} {dispatcherId === null ? '(registering…)' : `· ${dispatcherId}`}
        </span>
        <ConnectionBadge title="Telemetry" status={sseStatus} />
        <ConnectionBadge title="Dispatch" status={wsStatus} />
        <span className="online" title="Other dispatchers online (the server doesn't list those who joined before you)">
          👥 Online: You{others.length > 0 ? `, ${others.join(', ')}` : ''}
        </span>
      </div>
      {fleetStale && (
        <div className="banner banner-warn" role="status">
          ⚠ Fleet data is stale
          {fleetFetchedAt !== null ? ` since ${formatTime(fleetFetchedAt)}` : ''} — the server is not responding; showing
          the last known data. Retrying automatically.
        </div>
      )}
      {sseStatus === 'reconnecting' && (
        <div className="banner banner-warn" role="status">
          ⚠ Live telemetry interrupted — positions may be out of date. Reconnecting automatically.
        </div>
      )}
    </header>
  );
}
