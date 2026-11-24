/** Runs the in-app verification suite (src/verify/cases.ts) so its thresholds are enforced in CI. */
import { describe, expect, it } from 'vitest';
import { CASES, runCase } from '../src/verify/cases';

describe('verification suite (算法核验)', () => {
  for (const c of CASES.filter((x) => !x.gpu)) {
    it(`${c.id}: ${c.title}`, async () => {
      const r = await runCase(c);
      const lines = r.metrics.map((x) => `${x.label} = ${x.value.toExponential(3)} (${x.kind === 'max' ? '≤' : '≥'} ${x.limit})`);
      // eslint-disable-next-line no-console
      console.log(`[${c.id}] ${r.pass ? 'PASS' : 'FAIL'} ${r.ms.toFixed(0)} ms\n  ${lines.join('\n  ')}${r.detail ? `\n  ${r.detail}` : ''}`);
      expect(r.detail?.startsWith('运行出错') ? r.detail : 'ok').toBe('ok');
      for (const x of r.metrics) {
        if (x.kind === 'max') expect(x.value, x.label).toBeLessThanOrEqual(x.limit);
        else expect(x.value, x.label).toBeGreaterThanOrEqual(x.limit);
      }
    }, 60000);
  }
});
