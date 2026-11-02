// Observability panel (bonus, developer-facing): SSE messages/s, WebSocket latency, dropped messages, reconnects.
// Data flow: reads the transport clients' own counters (SseClient.stats, WsClient.stats) once per second, only while
// open. Deliberately NOT through the store: dev numbers changing every second shouldn't re-render dispatcher screens.
import { useEffect, useState, type ReactElement } from 'react';
import type { SseStats } from '../../transport/sseClient';
import type { WsStats } from '../../transport/wsClient';
import { addSample, ratePerSecond, type CounterSample } from '../eventRate';

const POLL_MS = 1000;

// Where the numbers come from — the running SSE and WS clients (RunningApp.sse / .ws).
export interface StatsSources {
  sse: { readonly stats: SseStats };
  ws: { readonly stats: WsStats };
}

interface Snapshot {
  sse: SseStats;
  ws: WsStats;
  samples: CounterSample[];
}

function formatRate(rate: number | null): string {
  return rate === null ? '…' : rate.toFixed(1);
}

export function ObservabilityPanel({ sources }: { sources: StatsSources }): ReactElement {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!open) return;
    function poll(): void {
      const sse = sources.sse.stats;
      const ws = sources.ws.stats;
      setSnapshot((previous) => ({
        sse,
        ws,
        samples: addSample(previous?.samples ?? [], { at: Date.now(), received: sse.received }),
      }));
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    // Cleanup: stop polling when closed or unmounted; start fresh next time (old samples would skew the rate).
    return () => {
      clearInterval(timer);
      setSnapshot(null);
    };
  }, [open, sources]);

  if (!open) {
    return (
      <button className="observability-toggle" onClick={() => setOpen(true)} title="Developer stats (not for dispatchers)">
        🛠 Dev
      </button>
    );
  }

  return (
    <aside className="panel observability" aria-label="Observability">
      <div className="observability-head">
        <strong>Observability</strong>
        <button onClick={() => setOpen(false)} aria-label="Close observability panel">
          ✕
        </button>
      </div>
      {snapshot === null ? (
        <p className="muted">Collecting…</p>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>SSE messages/s (10 s avg)</th>
              <td>{formatRate(ratePerSecond(snapshot.samples))}</td>
            </tr>
            <tr>
              <th>SSE received / dropped</th>
              <td>
                {snapshot.sse.received} / {snapshot.sse.dropped}
              </td>
            </tr>
            <tr>
              <th>SSE reconnects</th>
              <td>{snapshot.sse.reconnects}</td>
            </tr>
            <tr>
              <th>WS latency (ping → pong)</th>
              <td>{snapshot.ws.latencyMs === null ? '…' : `${snapshot.ws.latencyMs} ms`}</td>
            </tr>
            <tr>
              <th>WS received / dropped</th>
              <td>
                {snapshot.ws.received} / {snapshot.ws.dropped}
              </td>
            </tr>
            <tr>
              <th>WS reconnects</th>
              <td>{snapshot.ws.reconnects}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="muted">Dropped = failed validation (bad JSON or unknown shape). Counted since page load.</p>
    </aside>
  );
}
