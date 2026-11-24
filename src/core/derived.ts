/** Derived hydraulic quantities for display and export (docs/ALGORITHMS.md §6.3). */

/** Depth below which the bed shear stress is not evaluated (thin films give meaningless spikes). */
export const SHEAR_MIN_DEPTH = 0.01;

/**
 * Bed shear stress magnitude tau_b = rho g n^2 |V|^2 / h^(1/3) (Pa) from the Manning friction law,
 * i.e. the same stress the solver's implicit friction removes from the flow.
 */
export function bedShear(rho: number, g: number, n: number, h: number, u: number, v: number): number {
  if (!(h > SHEAR_MIN_DEPTH) || !(n > 0)) return 0;
  return (rho * g * n * n * (u * u + v * v)) / Math.cbrt(h);
}

/** Bed shear stress field (Pa) for depth/velocity arrays (row-major), with a per-cell or uniform n. */
export function bedShearField(
  h: ArrayLike<number>,
  u: ArrayLike<number>,
  v: ArrayLike<number>,
  manning: number,
  manningField: ArrayLike<number> | null,
  rho: number,
  out?: Float32Array,
): Float32Array {
  const n = h.length;
  const o = out && out.length === n ? out : new Float32Array(n);
  for (let k = 0; k < n; k++) o[k] = bedShear(rho, 9.81, manningField ? manningField[k] : manning, h[k], u[k], v[k]);
  return o;
}
