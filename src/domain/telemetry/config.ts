// Tunable thresholds for the telemetry pipeline, in one place.
// Values are generic physical / timing limits, not tied to the mock server's specific numbers.

// How far a reading's timestamp may be ahead of "now" (the server send time of the event that carried it)
// before we treat it as a clock bug. Covers network delay and small device clock drift.
export const MAX_FUTURE_SKEW_MS = 60_000;

// Max positions kept per truck for the map path (the recent tail). 300 × 2 s ≈ 10 minutes.
// Memory stays fixed so the app can run for hours. Full trip history would live in a backend database.
export const MAX_PATH_POINTS = 300;
