import { expect, test } from '@jest/globals';
import supertest from 'supertest';
import { createLifecycleLab } from '../src/lifecycle-lab.js';

test.each([
  ['7', false, 200, ['middleware', 'guard', 'interceptor:before', 'pipe', 'controller', 'interceptor:after', 'response:finish']],
  ['bad', false, 400, ['middleware', 'guard', 'interceptor:before', 'pipe', 'interceptor:error', 'filter', 'response:finish']],
  ['7', true, 403, ['middleware', 'guard', 'filter', 'response:finish']],
  ['13', false, 500, ['middleware', 'guard', 'interceptor:before', 'pipe', 'controller', 'interceptor:error', 'filter', 'response:finish']],
] as const)('value=%s，deny=%s 的生命週期與狀態 %s', async (value, deny, status, expected) => {
  const { app, events } = await createLifecycleLab(deny);
  try {
    const response = await supertest(app.getHttpServer()).get(`/lab/${value}`).expect(status);
    if (status === 200) expect(response.body).toEqual({ data: { value: 7, type: 'number' } });
    expect(events).toEqual(expected);
  } finally { await app.close(); }
});

test('裝飾器留下參數 metadata，轉型仍由 Pipe 負責', async () => {
  const { app, LabController } = await createLifecycleLab();
  try {
    expect(Reflect.getMetadata('design:paramtypes', LabController.prototype, 'value')).toEqual([Number]);
    const response = await supertest(app.getHttpServer()).get('/lab/not-a-number').expect(400);
    expect(response.body).toEqual({ error: 'lab error' });
  } finally { await app.close(); }
});
