// The detector registry: every sensor check the pipeline runs, in order.
// Add a new check by importing it here and adding it to the list — the pipeline itself never changes.
import type { SensorDetector } from '../sensors';
import { fuelDetector } from './fuel';
import { speedDetector } from './speed';

export const SENSOR_DETECTORS: readonly SensorDetector[] = [speedDetector, fuelDetector];
