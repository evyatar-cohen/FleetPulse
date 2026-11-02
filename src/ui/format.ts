// Pure display helpers: turn trusted sensor states and timestamps into the text the dispatcher sees.
// The dispatcher never sees a raw impossible value (999 km/h, glitch 0%) — only the trusted value plus a flag.
import type { TruckStatus } from '../domain/models';
import type { SensorState } from '../domain/telemetry/sensors';

export interface SensorDisplay {
  text: string;
  // Shown next to the value when the sensor isn't fully trusted; null when ok.
  flag: string | null;
}

const FLAGS: Readonly<Record<SensorState['status'], string | null>> = {
  ok: null,
  sensor_fault: '⚠ sensor fault',
  unverified: '⏳ checking',
};

function formatSensor(sensor: SensorState | undefined, unit: string, decimals: number): SensorDisplay {
  if (sensor === undefined || sensor.value === null) {
    return { text: '—', flag: sensor === undefined ? null : FLAGS[sensor.status] };
  }
  return { text: `${sensor.value.toFixed(decimals)} ${unit}`, flag: FLAGS[sensor.status] };
}

export function formatSpeed(sensor: SensorState | undefined): SensorDisplay {
  return formatSensor(sensor, 'km/h', 0);
}

export function formatFuel(sensor: SensorState | undefined): SensorDisplay {
  return formatSensor(sensor, '%', 0);
}

// "updated 4 s ago". Compares the reading's timestamp (server clock) with the browser clock — on one machine they
// match; with real clock skew the age would be off by the skew.
export function formatAge(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return 'no data yet';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

// Status → color. A registry: a new status = one entry.
export const STATUS_COLORS: Readonly<Record<TruckStatus, string>> = {
  active: '#2e7d32',
  idle: '#f9a825',
  maintenance: '#c62828',
};

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}
