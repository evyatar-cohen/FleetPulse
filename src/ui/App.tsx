// Root UI component: asks the dispatcher's name once, then starts the app (connections + store wiring) and shows the
// dashboard. Each area is wrapped in an error boundary so one crashing panel doesn't blank the whole page.
import { useEffect, useState, type ReactElement } from 'react';
import { browserDependencies, loadDispatcherName, saveDispatcherName } from '../app/browserDependencies';
import { startApp } from '../app/startup';
import { useFleetStore } from '../store/fleetStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMap } from './components/FleetMap';
import { Header } from './components/Header';
import { NameForm } from './components/NameForm';
import { TruckList } from './components/TruckList';

export function App(): ReactElement {
  const [dispatcherName, setDispatcherName] = useState<string | null>(() => loadDispatcherName());

  useEffect(() => {
    if (dispatcherName === null) return;
    const running = startApp(dispatcherName, browserDependencies(), useFleetStore);
    // Cleanup: close connections and timers (also makes React StrictMode's dev double-start safe).
    return () => running.stop();
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
    <main>
      <ErrorBoundary area="the header">
        <Header />
      </ErrorBoundary>
      <div className="layout">
        <ErrorBoundary area="the map">
          <FleetMap />
        </ErrorBoundary>
        <ErrorBoundary area="the truck list">
          <TruckList />
        </ErrorBoundary>
      </div>
    </main>
  );
}
