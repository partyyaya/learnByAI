import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export interface RequestTrace {
  requestId: string;
  outcome: 'finished' | 'interrupted';
  status?: number;
  steps: string[];
}
export function requestContext(onTrace?: (trace: RequestTrace) => void): RequestHandler {
  return (_req, res, next) => {
    // 本課由服務產生 ID；不直接信任外部傳入的 X-Request-ID。
    const requestId = randomUUID();
    const steps = ['request'];
    res.locals.requestId = requestId; res.locals.steps = steps;
    res.setHeader('X-Request-ID', requestId);
    const report = (outcome: RequestTrace['outcome']) => {
      res.off('finish', onFinish); res.off('close', onClose);
      steps.push(outcome === 'finished' ? 'response:finish' : 'response:close');
      onTrace?.({ requestId, outcome, ...(res.headersSent ? { status: res.statusCode } : {}), steps: [...steps] });
    };
    const onFinish = () => report('finished');
    const onClose = () => report('interrupted');
    res.once('finish', onFinish); res.once('close', onClose);
    next();
  };
}
export function step(name: string): RequestHandler {
  return (_req, res, next) => { res.locals.steps.push(name); next(); };
}
