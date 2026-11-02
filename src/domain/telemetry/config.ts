// Tunable thresholds for the telemetry pipeline, in one place.
// Values are generic physical / timing limits, not tied to the mock server's specific numbers.

// How far a reading's timestamp may be ahead of "now" (the server send time of the event that carried it)
// before we treat it as a clock bug. Covers network delay and small device clock drift.
export const MAX_FUTURE_SKEW_MS: number = 60_000;

// Max positions kept per truck for the map path (the recent tail). 300 × 2 s ≈ 10 minutes.
// Memory stays fixed so the app can run for hours. Full trip history would live in a backend database.
export const MAX_PATH_POINTS: number = 300;

// How long a sudden sensor jump stays 'unverified' before we accept it as real.
// Longest known glitch (2–4 s, from server.js QUIRK 2) + one reading interval (2 s) to see it end = 6 s.
// Too long would hide a real problem — this is the safety bound.
export const FUEL_CONFIRM_WINDOW_MS: number = 6000;

// The fuel rate check allows change in proportion to the time since the previous reading, but only up to this
// gap (2 readings). After a longer gap we can't judge a big change, so it waits for the confirm window instead.
export const FUEL_MAX_RATE_GAP_MS: number = 4000;

// Trusted sensor samples kept per truck for the detail charts: 150 × 2 s ≈ 5 minutes. Fixed memory over hours.
export const MAX_HISTORY_SAMPLES: number = 150;
