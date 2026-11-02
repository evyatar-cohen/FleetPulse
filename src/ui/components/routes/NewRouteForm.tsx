// "New route" form. Only trucks that can take a route are selectable; the others show why not (maintenance, busy).
// Field errors come from the same domain rules the action enforces (routeRules.validateNewRoute).
import { useState, type FormEvent, type ReactElement } from 'react';
import type { RouteActions } from '../../../app/routeActions';
import type { RoutePriority } from '../../../domain/models';
import { DESTINATION_MAX_LENGTH, NOTES_MAX_LENGTH, whyTruckCannotTakeRoute, type FieldErrors } from '../../../domain/routeRules';
import { useFleetStore } from '../../../store/fleetStore';
import { useThrottledStore } from '../../useThrottledStore';
import { dispatcherLabel } from '../../routeFormat';
import { selectTrucks, sortedTrucks } from '../../selectors';

const PRIORITIES: readonly RoutePriority[] = ['low', 'normal', 'high'];

export function NewRouteForm({ actions }: { actions: RouteActions }): ReactElement {
  // Truck names/route ids only — read through the 1 s throttle so telemetry doesn't redraw this every 2 s.
  const trucks = useThrottledStore(selectTrucks);
  const myId = useFleetStore((state) => state.dispatcherId);
  const names = useFleetStore((state) => state.dispatcherNames);
  const [truckId, setTruckId] = useState('');
  const [destination, setDestination] = useState('');
  const [priority, setPriority] = useState<RoutePriority>('normal');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const outcome = await actions.createRoute({ truckId, destination, priority, notes });
    setSaving(false);
    setErrors({});

    if (outcome.kind === 'success') {
      setDestination('');
      setNotes('');
      setTruckId('');
      setMessage('✓ Route created');
    } else if (outcome.kind === 'invalid') {
      if (typeof outcome.errors === 'string') setMessage(outcome.errors);
      else setErrors(outcome.errors);
    } else if (outcome.kind === 'truck_taken') {
      setMessage(
        outcome.byMe
          ? `This truck already has your route ${outcome.routeId} (perhaps your earlier attempt went through).`
          : `This truck was just given route ${outcome.routeId} by ${dispatcherLabel(outcome.by, myId, names)}.`,
      );
    } else if (outcome.kind === 'error') {
      setMessage(outcome.retryable ? `${outcome.message} Check the routes list before trying again.` : outcome.message);
    }
  }

  return (
    <form className="route-form" onSubmit={(event) => void handleSubmit(event)}>
      <h3>New route</h3>
      <label>
        Truck
        <select value={truckId} onChange={(event) => setTruckId(event.target.value)} required>
          <option value="">Choose a truck…</option>
          {sortedTrucks(trucks).map((truck) => {
            const reason = whyTruckCannotTakeRoute(truck);
            return (
              <option key={truck.id} value={truck.id} disabled={reason !== null}>
                {truck.name}
                {reason !== null ? ` — ${reason}` : ''}
              </option>
            );
          })}
        </select>
        {errors.truckId !== undefined && <span className="field-error">{errors.truckId}</span>}
      </label>
      <label>
        Destination
        <input value={destination} onChange={(event) => setDestination(event.target.value)} maxLength={DESTINATION_MAX_LENGTH} />
        {errors.destination !== undefined && <span className="field-error">{errors.destination}</span>}
      </label>
      <label>
        Priority
        <select value={priority} onChange={(event) => setPriority(event.target.value as RoutePriority)}>
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Notes (optional)
        <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={NOTES_MAX_LENGTH} />
        {errors.notes !== undefined && <span className="field-error">{errors.notes}</span>}
      </label>
      <button type="submit" disabled={saving || truckId === ''}>
        {saving ? '⏳ Saving…' : 'Create route'}
      </button>
      {message !== null && <p className="form-message">{message}</p>}
    </form>
  );
}
