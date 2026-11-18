/** Browser-side tile fetching helpers (CORS-enabled open tile services). */

export interface TileProgress {
  done: number;
  total: number;
}

/** Run async jobs with a concurrency limit. */
export async function pool<T>(jobs: (() => Promise<T>)[], limit: number, onDone?: (n: number) => void): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const k = next++;
      results[k] = await jobs[k]();
      done++;
      onDone?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

/** Fetch an image tile and decode it to an ImageBitmap without colour-space conversion. */
export async function fetchImageBitmap(url: string, signal?: AbortSignal, retries = 2): Promise<ImageBitmap | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal, mode: 'cors' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;

/** Read RGBA pixels of a bitmap. */
export function bitmapPixels(bmp: ImageBitmap): Uint8ClampedArray {
  const w = bmp.width;
  const h = bmp.height;
  if (!scratch || scratch.width !== w || scratch.height !== h) {
    scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}
