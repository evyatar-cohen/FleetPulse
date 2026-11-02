// Vehicle detail panel (opens when a truck is selected): live trusted speed / fuel / engine-temperature charts, mileage
// (only in GET /api/fleet/:id — loaded on open and refreshed), the assigned route, who else is viewing this truck,
// recent alerts, and a form to send an alert (critical ones need confirmation).
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { TruckActions } from '../../app/truckActions';
import { alertNeedsConfirmation, ALERT_MESSAGE_MAX_LENGTH, type AlertDraft } from '../../domain/alerts';
import { truckStatus } from '../../domain/fleet';
import type { AlertSeverity } from '../../domain/models';
import { viewersOf } from '../../domain/presence';
import { isLowFuel } from '../../domain/telemetry/fuelAlert';
import { getVehicleProfile } from '../../domain/vehicles';
import { useFleetStore } from '../../store/fleetStore';
import { formatFuel, formatSpeed, formatTime, STATUS_COLORS } from '../format';
import { dispatcherLabel } from '../routeFormat';
import { selectTrucks } from '../selectors';
import { useThrottledStore } from '../useThrottledStore';
import { ConfirmDialog } from './Modal';
import { Sparkline } from './Sparkline';

// Mileage changes slowly; refresh it while the panel is open.
const DETAIL_REFRESH_MS = 30_000;
const SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

function useMileage(truckId: string, actions: TruckActions): number | null {
  const [mileage, setMileage] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const result = await actions.loadDetail(truckId);
      // Ignore answers that arrive after the panel switched truck or closed.
      if (!cancelled && result.ok) setMileage(result.data.mileage);
    }
    setMileage(null);
    void load();
    const timer = setInterval(() => void load(), DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [truckId, actions]);
  return mileage;
}

function SendAlertForm({ truckId, actions }: { truckId: string; actions: TruckActions }): ReactElement {
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<AlertSeverity>('info');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function send(draft: AlertDraft): Promise<void> {
    setSending(true);
    setFeedback(null);
    const outcome = await actions.sendAlert(truckId, draft);
    setSending(false);
    if (outcome.kind === 'sent') {
      setMessage('');
      setFeedback('✓ Alert sent');
    } else {
      setFeedback(outcome.message);
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (alertNeedsConfirmation(severity)) {
      setConfirming(true);
      return;
    }
    void send({ message, severity });
  }

  return (
    <form className="alert-form" onSubmit={handleSubmit}>
      <input
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Message to the driver"
        maxLength={ALERT_MESSAGE_MAX_LENGTH}
      />
      <select value={severity} onChange={(event) => setSeverity(event.target.value as AlertSeverity)}>
        {SEVERITIES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <button type="submit" disabled={sending || message.trim() === ''}>
        {sending ? '⏳ Sending…' : 'Send alert'}
      </button>
      {feedback !== null && <p className="form-message">{feedback}</p>}
      {confirming && (
        <ConfirmDialog
          title="Send a critical alert?"
          message={`"${message.trim()}" will be sent to the driver as CRITICAL.`}
          confirmLabel="Send critical alert"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void send({ message, severity });
          }}
        />
      )}
    </form>
  );
}

interface TruckDetailPanelProps {
  truckId: string;
  actions: TruckActions;
  onClose: () => void;
}

export function TruckDetailPanel({ truckId, actions, onClose }: TruckDetailPanelProps): ReactElement {
  const trucks = useThrottledStore(selectTrucks);
  const routes = useFleetStore((state) => state.routes);
  const presence = useFleetStore((state) => state.presence);
  const alerts = useFleetStore((state) => state.alerts);
  const myId = useFleetStore((state) => state.dispatcherId);
  const names = useFleetStore((state) => state.dispatcherNames);
  const mileage = useMileage(truckId, actions);

  const truck = trucks[truckId];
  if (truck === undefined) {
    return (
      <aside className="detail-panel">
        <p>Truck not found.</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  }

  const status = truckStatus(truck);
  const telemetry = truck.telemetry;
  const history = telemetry?.history ?? [];
  const fuelSensor = telemetry?.sensors['fuel'];
  const speed = formatSpeed(telemetry?.sensors['speed']);
  const fuel = formatFuel(fuelSensor, isLowFuel(fuelSensor, getVehicleProfile(truck.vehicleType)));
  const route = truck.currentRouteId === null ? undefined : routes[truck.currentRouteId];
  const viewers = viewersOf(presence, truckId);
  const truckAlerts = alerts.filter((alert) => alert.truckId === truckId).reverse();

  return (
    <aside className="detail-panel" aria-label={`${truck.name} details`}>
      <div className="detail-header">
        <h2>
          <span className="status-dot" style={{ backgroundColor: STATUS_COLORS[status] }} />
          {truck.name}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <p className="muted">
        {status} · {truck.vehicleType} · mileage {mileage === null ? '…' : `${mileage.toLocaleString()} km`}
      </p>
      {viewers.length > 0 && (
        <p className="viewers">👁 Also viewing: {viewers.map((viewer) => dispatcherLabel(viewer.id, myId, names)).join(', ')}</p>
      )}

      <div className="detail-now">
        <span>Speed: {speed.text} {speed.flag}</span>
        <span>Fuel: {fuel.text} {fuel.flag}</span>
        <span>Engine: {telemetry === undefined ? '—' : `${telemetry.current.engineTemp.toFixed(0)} °C`}</span>
      </div>

      <Sparkline label="Speed" unit="km/h" values={history.map((sample) => sample.speed)} />
      <Sparkline label="Fuel" unit="%" values={history.map((sample) => sample.fuel)} fixedRange={{ min: 0, max: 100 }} />
      <Sparkline label="Engine temp" unit="°C" values={history.map((sample) => sample.engineTemp)} />

      <h3>Route</h3>
      {route === undefined ? (
        <p className="muted">No route assigned.</p>
      ) : (
        <p>
          {route.id} → <strong>{route.destination}</strong> · {route.status} · priority {route.priority}
          <br />
          <span className="muted">
            assigned by {dispatcherLabel(route.assignedBy, myId, names)}
            {route.notes !== '' ? ` · "${route.notes}"` : ''}
          </span>
        </p>
      )}

      <h3>Alerts</h3>
      <SendAlertForm truckId={truckId} actions={actions} />
      {truckAlerts.length === 0 ? (
        <p className="muted">No alerts sent to this truck yet.</p>
      ) : (
        <ul className="audit-log">
          {truckAlerts.map((alert) => (
            <li key={alert.id}>
              <span className="muted">{formatTime(alert.timestamp)}</span> <strong>[{alert.severity}]</strong>{' '}
              {alert.message} <span className="muted">— {dispatcherLabel(alert.sentBy ?? null, myId, names)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
