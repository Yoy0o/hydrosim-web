/// <reference lib="webworker" />
/** Runs verification cases (src/verify/cases.ts) off the main thread for the 算法核验 dialog. */
import { CASES, runCase, type VerifyResult } from './cases';

export type VerifyRequest = { type: 'run'; ids: string[] };
export type VerifyReply = { type: 'start'; id: string } | { type: 'result'; result: VerifyResult } | { type: 'done' };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<VerifyRequest>) => {
  if (e.data.type !== 'run') return;
  for (const id of e.data.ids) {
    const c = CASES.find((x) => x.id === id);
    if (!c) continue;
    scope.postMessage({ type: 'start', id } satisfies VerifyReply);
    const result = await runCase(c);
    scope.postMessage({ type: 'result', result } satisfies VerifyReply);
  }
  scope.postMessage({ type: 'done' } satisfies VerifyReply);
};
