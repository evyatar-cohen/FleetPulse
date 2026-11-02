// Root UI component: asks the dispatcher's name once, then starts the app (connections + store wiring) and shows the
// dashboard. Each area is wrapped in an error boundary so one crashing panel doesn't blank the whole page.
import { useEffect, useState, type ReactElement } from 'react';
import type { RouteActions } from '../app/routeActions';
import { browserDependencies, loadDispatcherName, saveDispatcherName } from '../app/browserDependencies';
import { startApp } from '../app/startup';
import { useFleetStore } from '../store/fleetStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMap } from './components/FleetMap';
import { Header } from './components/Header';
import { NameForm } from './components/NameForm';
import { AuditLogPanel } from './components/routes/AuditLogPanel';
import { RoutesPanel } from './components/routes/RoutesPanel';
import { TruckList } from './components/TruckList';

export function App(): ReactElement {
  const [dispatcherName, setDispatcherName] = useState<string | null>(() => loadDispatcherName());
  const [routeActions, setRouteActions] = useState<RouteActions | null>(null);

  useEffect(() => {
    if (dispatcherName === null) return;
    const running = startApp(dispatcherName, browserDependencies(), useFleetStore);
    setRouteActions(running.routeActions);
    // Cleanup: close connections and timers (also makes React StrictMode's dev double-start safe).
    return () => {
      running.stop();
      setRouteActions(null);
    };
  }, [dispatcherName]);

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
            <FleetMap />
          </ErrorBoundary>
        </div>
        <div className="area-trucks">
          <ErrorBoundary area="the truck list">
            <TruckList />
          </ErrorBoundary>
        </div>
        <div className="area-routes">
          <ErrorBoundary area="the routes panel">
            {routeActions === null ? <p className="muted">Starting…</p> : <RoutesPanel actions={routeActions} />}
          </ErrorBoundary>
        </div>
        <div className="area-history">
          <ErrorBoundary area="the route history">
            <AuditLogPanel />
          </ErrorBoundary>
        </div>
      </div>
    </main>
  );
}
