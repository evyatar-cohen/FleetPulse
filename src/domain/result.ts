// Result type: a function returns either data or an error as a VALUE (no exceptions for expected failures).
// The caller must check `ok` before using `data` — the compiler enforces it.
// Python analogy: returning Ok | Err instead of raising.

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err<E> {
  ok: false;
  error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
