import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';

import { GET } from '../../app/api/internal/application-upload-cleanup/route.ts';

test('scheduled upload cleanup fails closed without its production bearer secret', async t => {
  const previous = process.env.CRON_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });

  delete process.env.CRON_SECRET;
  const absent = await GET(new NextRequest('http://localhost/api/internal/application-upload-cleanup'));
  assert.equal(absent.status, 401);

  process.env.CRON_SECRET = 'a-secret-with-enough-entropy-for-this-test';
  const wrong = await GET(new NextRequest('http://localhost/api/internal/application-upload-cleanup', {
    headers: { Authorization: 'Bearer not-the-secret' },
  }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
});
