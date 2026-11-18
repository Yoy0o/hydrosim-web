/** A time series as an array of [t (seconds), value] pairs, sorted by t. */
export type TimeSeries = [number, number][];

/**
 * Sample a time series at time t.
 * - linear (default): piecewise-linear interpolation, values held constant outside the range.
 * - stepwise: value of the last point with time <= t (zero-order hold).
 */
export function sampleSeries(s: TimeSeries, t: number, stepwise = false): number {
  const n = s.length;
  if (n === 0) return 0;
  if (t <= s[0][0]) return stepwise && t < s[0][0] ? 0 : s[0][1];
  if (t >= s[n - 1][0]) return s[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  if (stepwise) return s[lo][1];
  const t0 = s[lo][0];
  const t1 = s[hi][0];
  const v0 = s[lo][1];
  const v1 = s[hi][1];
  return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
}

/** Integral of the series between t0 and t1 (exact for linear/stepwise interpolation). */
export function integrateSeries(s: TimeSeries, t0: number, t1: number, stepwise = false, samples = 0): number {
  if (t1 <= t0 || s.length === 0) return 0;
  // Collect breakpoints inside the interval for exact piecewise integration.
  const pts: number[] = [t0];
  for (const [t] of s) if (t > t0 && t < t1) pts.push(t);
  pts.push(t1);
  let sum = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (stepwise) {
      sum += sampleSeries(s, a + 1e-9 * (b - a), true) * (b - a);
    } else if (samples > 0) {
      for (let m = 0; m < samples; m++) {
        const ta = a + ((b - a) * m) / samples;
        const tb = a + ((b - a) * (m + 1)) / samples;
        sum += 0.5 * (sampleSeries(s, ta) + sampleSeries(s, tb)) * (tb - ta);
      }
    } else {
      sum += 0.5 * (sampleSeries(s, a) + sampleSeries(s, b)) * (b - a);
    }
  }
  return sum;
}

/** Triangular hydrograph: base -> peak at tPeak -> base at tEnd. */
export function triangularHydrograph(base: number, peak: number, tPeak: number, tEnd: number): TimeSeries {
  return [
    [0, base],
    [tPeak, peak],
    [tEnd, base],
  ];
}

/** Parse "t, value" lines. Time unit multiplier converts the first column to seconds. */
export function parseSeriesText(text: string, timeUnit = 1): TimeSeries {
  const out: TimeSeries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\s,;\t]+/).map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      out.push([parts[0] * timeUnit, parts[1]]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

export function seriesToText(s: TimeSeries, timeUnit = 1, digits = 3): string {
  return s.map(([t, v]) => `${+(t / timeUnit).toFixed(digits)}, ${+v.toFixed(digits)}`).join('\n');
}

export function seriesMax(s: TimeSeries): number {
  let m = -Infinity;
  for (const [, v] of s) if (v > m) m = v;
  return s.length ? m : 0;
}
