// Root UI component: asks the dispatcher's name once, then starts the app (connections + store wiring) and shows the
// dashboard. Each area is wrapped in an error boundary so one crashing panel doesn't blank the whole page.
import { useEffect, useState, type ReactElement } from 'react';
import type { RunningApp } from '../app/startup';
import { browserDependencies, loadDispatcherName, saveDispatcherName } from '../app/browserDependencies';
import { startApp } from '../app/startup';
import { useFleetStore } from '../store/fleetStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMap } from './components/FleetMap';
import { Header } from './components/Header';
import { NameForm } from './components/NameForm';
import { ObservabilityPanel } from './components/ObservabilityPanel';
import { AuditLogPanel } from './components/routes/AuditLogPanel';
import { RoutesPanel } from './components/routes/RoutesPanel';
import { TruckDetailPanel } from './components/TruckDetailPanel';
import { TruckList } from './components/TruckList';

export function App(): ReactElement {
  const [dispatcherName, setDispatcherName] = useState<string | null>(() => loadDispatcherName());
  // The running app's actions (routes, truck detail/alerts, selection) — null until started.
  const [running, setRunning] = useState<RunningApp | null>(null);
  const selectedTruckId = useFleetStore((state) => state.selectedTruckId);

  useEffect(() => {
    if (dispatcherName === null) return;
    const app = startApp(dispatcherName, browserDependencies(), useFleetStore);
    setRunning(app);
    // Cleanup: close connections and timers (also makes React StrictMode's dev double-start safe).
    return () => {
      app.stop();
      setRunning(null);
    };
  }, [dispatcherName]);

  function selectTruck(truckId: string | null): void {
    running?.selectTruck(truckId);
  }

  if (dispatcherName === null) {
    return (
      <NameForm
        onSubmit={(name) => {
          saveDispatcherName(name);
          setDispatcherName(name);
        }}
      />
    );
  }

  return (
    <main className="app">
      <ErrorBoundary area="the header">
        <Header />
      </ErrorBoundary>
      {/* One-screen dashboard: each area scrolls on its own (see .dashboard in styles.css). */}
      <div className="dashboard">
        <div className="area-map">
          <ErrorBoundary area="the map">
            <FleetMap onSelect={selectTruck} />
          </ErrorBoundary>
        </div>
        <div className="area-trucks">
          <ErrorBoundary area="the truck list">
            <TruckList onSelect={selectTruck} />
          </ErrorBoundary>
        </div>
        <div className="area-routes">
          <ErrorBoundary area="the routes panel">
            {running === null ? <p className="muted">Starting…</p> : <RoutesPanel actions={running.routeActions} />}
          </ErrorBoundary>
        </div>
        <div className="area-history">
          <ErrorBoundary area="the route history">
            <AuditLogPanel />
          </ErrorBoundary>
        </div>
      </div>
      {running !== null && selectedTruckId !== null && (
        <ErrorBoundary area="the truck details">
          <TruckDetailPanel truckId={selectedTruckId} actions={running.truckActions} onClose={() => selectTruck(null)} />
        </ErrorBoundary>
      )}
      {running !== null && (
        <ErrorBoundary area="the observability panel">
          <ObservabilityPanel sources={running} />
        </ErrorBoundary>
      )}
    </main>
  );
}
