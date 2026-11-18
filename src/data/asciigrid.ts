/** ESRI ASCII Grid (.asc) import/export. */
import type { Terrain } from '../types';

export interface AscGrid {
  ncols: number;
  nrows: number;
  xll: number;
  yll: number;
  cellsize: number;
  nodata: number;
  /** Row-major values, row 0 = SOUTH (converted from the file's north-first order). */
  data: Float32Array;
}

/** Fast tokenizer-based parser (handles xllcorner/xllcenter, NODATA_value, dx/dy). */
export function parseAsc(text: string): AscGrid {
  const header: Record<string, number> = {};
  let pos = 0;
  const n = text.length;
  const readToken = (): string | null => {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44) pos++;
      else break;
    }
    if (pos >= n) return null;
    const start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44) break;
      pos++;
    }
    return text.slice(start, pos);
  };
  // header: key value pairs until the first numeric token
  for (;;) {
    const save = pos;
    const key = readToken();
    if (key === null) throw new Error('ASC 文件为空');
    if (/^[-+]?(\d|\.\d)/.test(key)) {
      pos = save;
      break;
    }
    const val = readToken();
    if (val === null) throw new Error('ASC 头信息不完整');
    header[key.toLowerCase()] = Number(val);
  }
  const ncols = header.ncols;
  const nrows = header.nrows;
  if (!(ncols > 0 && nrows > 0)) throw new Error('ASC 头缺少 ncols/nrows');
  const cellsize = header.cellsize ?? header.dx;
  if (!(cellsize > 0)) throw new Error('ASC 头缺少 cellsize');
  let xll = header.xllcorner ?? 0;
  let yll = header.yllcorner ?? 0;
  if (header.xllcenter !== undefined) xll = header.xllcenter - cellsize / 2;
  if (header.yllcenter !== undefined) yll = header.yllcenter - cellsize / 2;
  const nodata = header.nodata_value ?? -9999;
  const data = new Float32Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const row = nrows - 1 - r; // file is north-first
    for (let c = 0; c < ncols; c++) {
      const tok = readToken();
      if (tok === null) throw new Error(`ASC 数据不足：第 ${r + 1} 行`);
      data[row * ncols + c] = Number(tok);
    }
  }
  return { ncols, nrows, xll, yll, cellsize, nodata, data };
}

/** Convert to a simulation terrain, block-averaging to at most `maxCells` along the longer side. */
export function ascToTerrain(g: AscGrid, maxCells: number, name: string): Terrain {
  const f = Math.max(1, Math.ceil(Math.max(g.ncols, g.nrows) / maxCells));
  const nx = Math.floor(g.ncols / f);
  const ny = Math.floor(g.nrows / f);
  const z = new Float32Array(nx * ny);
  const isNo = (v: number): boolean => !Number.isFinite(v) || Math.abs(v - g.nodata) < 1e-6 || v < -1e5;
  let zMax = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      let cnt = 0;
      for (let b = 0; b < f; b++) {
        for (let a = 0; a < f; a++) {
          const v = g.data[(j * f + b) * g.ncols + i * f + a];
          if (!isNo(v)) {
            sum += v;
            cnt++;
          }
        }
      }
      const v = cnt > 0 ? sum / cnt : NaN;
      z[j * nx + i] = v;
      if (v > zMax) zMax = v;
    }
  }
  // NODATA cells become high ground (act as walls)
  let filled = 0;
  for (let k = 0; k < z.length; k++) {
    if (Number.isNaN(z[k])) {
      z[k] = zMax + 10;
      filled++;
    }
  }
  const cs = g.cellsize * f;
  return {
    name: filled > 0 ? `${name}（${filled} 个无数据网格按高地处理）` : name,
    nx,
    ny,
    dx: cs,
    dy: cs,
    z,
    georef: { kind: 'projected', xll: g.xll, yll: g.yll, cellsize: cs },
    source: 'asc',
  };
}

/** Write a south-first value array as ESRI ASCII grid text. Values for which `valid` is false are NODATA. */
export function writeAsc(
  nx: number,
  ny: number,
  cellsize: number,
  xll: number,
  yll: number,
  values: ArrayLike<number>,
  valid: (v: number, k: number) => boolean = () => true,
  digits = 3,
  nodata = -9999,
): string {
  const lines: string[] = [
    `ncols ${nx}`,
    `nrows ${ny}`,
    `xllcorner ${xll}`,
    `yllcorner ${yll}`,
    `cellsize ${cellsize}`,
    `NODATA_value ${nodata}`,
  ];
  for (let r = ny - 1; r >= 0; r--) {
    const row: string[] = new Array(nx);
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c;
      const v = values[k];
      row[c] = valid(v, k) && Number.isFinite(v) ? (+v.toFixed(digits)).toString() : String(nodata);
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n') + '\n';
}
