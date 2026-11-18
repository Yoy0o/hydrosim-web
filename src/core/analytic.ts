/** Analytical solutions used for verification (tests) and benchmark overlays. */

/** Ritter (1892) dam break on a dry, frictionless, horizontal bed. Returns [h, u]. */
export function ritter(x: number, t: number, x0: number, h0: number, g = 9.81): [number, number] {
  const c0 = Math.sqrt(g * h0);
  if (t <= 0) return x < x0 ? [h0, 0] : [0, 0];
  const xi = (x - x0) / t;
  if (xi <= -c0) return [h0, 0];
  if (xi >= 2 * c0) return [0, 0];
  const s = 2 * c0 - xi;
  return [(s * s) / (9 * g), (2 / 3) * (xi + c0)];
}

/** Intermediate state of the Stoker (wet bed) dam break: returns { hm, um, shock speed }. */
export function stokerState(h0: number, h1: number, g = 9.81): { hm: number; um: number; s: number } {
  const c0 = Math.sqrt(g * h0);
  const f = (hm: number): number => {
    const um = 2 * (c0 - Math.sqrt(g * hm));
    const us = (hm - h1) * Math.sqrt((g * (hm + h1)) / (2 * hm * h1));
    return um - us;
  };
  let lo = h1;
  let hi = h0;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const hm = 0.5 * (lo + hi);
  const um = 2 * (c0 - Math.sqrt(g * hm));
  const s = (um * hm) / (hm - h1);
  return { hm, um, s };
}

/** Stoker (1957) dam break on a wet horizontal bed (h0 upstream, h1 downstream). Returns [h, u]. */
export function stoker(x: number, t: number, x0: number, h0: number, h1: number, g = 9.81): [number, number] {
  if (t <= 0) return x < x0 ? [h0, 0] : [h1, 0];
  const c0 = Math.sqrt(g * h0);
  const { hm, um, s } = stokerState(h0, h1, g);
  const cm = Math.sqrt(g * hm);
  const xi = (x - x0) / t;
  if (xi <= -c0) return [h0, 0];
  if (xi <= um - cm) {
    const q = 2 * c0 - xi;
    return [(q * q) / (9 * g), (2 / 3) * (xi + c0)];
  }
  if (xi <= s) return [hm, um];
  return [h1, 0];
}

/**
 * Thacker (1981) planar surface oscillation in a paraboloid z(r) = -D0 (1 - r^2 / a^2),
 * x-only variant starting from rest: the free surface stays planar, velocity is uniform:
 *   eta(x, t) = (eta0 D0 / a^2) (2 x cos(wt) - eta0 (cos(2wt) + 1) / 2),  u = -eta0 w sin(wt),  w = sqrt(2 g D0) / a
 * Coordinates are relative to the bowl centre. Returns the free-surface elevation (valid where it is above the bed).
 */
export function thackerSurface(x: number, t: number, D0: number, a: number, eta0: number, g = 9.81): number {
  const w = Math.sqrt(2 * g * D0) / a;
  return ((eta0 * D0) / (a * a)) * (2 * x * Math.cos(w * t) - (eta0 * (Math.cos(2 * w * t) + 1)) / 2);
}

export function thackerPeriod(D0: number, a: number, g = 9.81): number {
  return (2 * Math.PI * a) / Math.sqrt(2 * g * D0);
}
