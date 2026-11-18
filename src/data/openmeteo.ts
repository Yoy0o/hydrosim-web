/**
 * Open-Meteo open data APIs (free for non-commercial use, data CC BY 4.0, CORS enabled):
 *  - Historical Weather API (ERA5 / ERA5-Land reanalysis): hourly precipitation
 *  - Flood API (Copernicus GloFAS v4): daily river discharge
 */
import type { TimeSeries } from '../core/timeseries';

export const OPEN_METEO_ATTRIBUTION = '气象/水文数据: Open-Meteo.com (ERA5 再分析 · Copernicus GloFAS), CC BY 4.0';

export interface HourlyRain {
  latitude: number;
  longitude: number;
  time: string[];
  precipitation: (number | null)[];
}

export interface DailyDischarge {
  latitude: number;
  longitude: number;
  time: string[];
  river_discharge: (number | null)[];
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { reason?: string };
      if (j.reason) reason += `: ${j.reason}`;
    } catch {
      /* ignore */
    }
    throw new Error(reason);
  }
  return (await res.json()) as T;
}

export async function fetchHourlyRain(lat: number, lon: number, startDate: string, endDate: string, signal?: AbortSignal): Promise<HourlyRain> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${startDate}&end_date=${endDate}&hourly=precipitation&timezone=UTC`;
  const j = await getJson<{ latitude: number; longitude: number; hourly: { time: string[]; precipitation: (number | null)[] } }>(url, signal);
  return { latitude: j.latitude, longitude: j.longitude, time: j.hourly.time, precipitation: j.hourly.precipitation };
}

export async function fetchDailyDischarge(lat: number, lon: number, startDate: string, endDate: string, signal?: AbortSignal): Promise<DailyDischarge> {
  const url =
    `https://flood-api.open-meteo.com/v1/flood?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&daily=river_discharge&start_date=${startDate}&end_date=${endDate}`;
  const j = await getJson<{ latitude: number; longitude: number; daily: { time: string[]; river_discharge: (number | null)[] } }>(url, signal);
  return { latitude: j.latitude, longitude: j.longitude, time: j.daily.time, river_discharge: j.daily.river_discharge };
}

function utcMs(iso: string): number {
  return Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso.endsWith('Z') ? iso : `${iso}Z`);
}

/**
 * Hourly precipitation (sum over the preceding hour) -> stepwise intensity series (mm/h) relative to t0.
 * The record stamped T covers [T-1h, T). A terminal zero stops rain after the data ends.
 */
export function rainSeriesFromHourly(r: HourlyRain, t0Iso: string, durationS = Infinity): TimeSeries {
  const t0 = utcMs(t0Iso);
  const s: TimeSeries = [];
  let last = 0;
  for (let k = 0; k < r.time.length; k++) {
    const tEnd = (utcMs(r.time[k]) - t0) / 1000;
    const tStart = tEnd - 3600;
    if (tEnd <= 0 || tStart >= durationS) continue;
    const v = r.precipitation[k] ?? 0;
    s.push([Math.max(0, tStart), v]);
    last = tEnd;
  }
  if (s.length) s.push([last, 0]);
  return s;
}

/** Daily mean discharge -> linear series (m^3/s) with values placed at noon of each day. */
export function dischargeSeriesFromDaily(d: DailyDischarge, t0Iso: string): TimeSeries {
  const t0 = utcMs(t0Iso);
  const s: TimeSeries = [];
  for (let k = 0; k < d.time.length; k++) {
    const v = d.river_discharge[k];
    if (v == null) continue;
    s.push([(utcMs(d.time[k]) + 12 * 3600 * 1000 - t0) / 1000, v]);
  }
  return s;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
