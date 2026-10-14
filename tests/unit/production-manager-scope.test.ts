import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';

import { createProductionManagerScopeGet } from '../../app/api/application/manager-scope/route.ts';

const userId = '4fe3f369-6423-462d-9d87-61e9f9976dd5';

function request(token?: string): NextRequest {
  return new NextRequest('http://localhost/api/application/manager-scope', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test('manager scope rejects missing and unverified credentials before querying memberships', async () => {
  let queries = 0;
  const GET = createProductionManagerScopeGet({
    verifyUser: async () => null,
    listMerchants: async () => { queries += 1; return []; },
  });
  const missing = await GET(request());
  assert.equal(missing.status, 401);
  const unverified = await GET(request('A'.repeat(32)));
  assert.equal(unverified.status, 401);
  assert.equal(queries, 0);
});

test('manager scope queries only the verified user and never caches workspace data', async () => {
  const calls: string[] = [];
  const GET = createProductionManagerScopeGet({
    verifyUser: async jwt => { calls.push(jwt); return userId; },
    listMerchants: async actorId => {
      calls.push(actorId);
      return [{ id: '70e2d331-7f8b-449a-8d8b-25844c7fb0a8', name: 'Cocoa Bakery', role: 'manager' }];
    },
  });
  const response = await GET(request('A'.repeat(32)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    merchants: [{ id: '70e2d331-7f8b-449a-8d8b-25844c7fb0a8', name: 'Cocoa Bakery', role: 'manager' }],
  });
  assert.deepEqual(calls, ['A'.repeat(32), userId]);
});

test('manager scope fails closed when membership lookup fails', async () => {
  const GET = createProductionManagerScopeGet({
    verifyUser: async () => userId,
    listMerchants: async () => { throw new Error('Database unavailable'); },
  });
  const response = await GET(request('A'.repeat(32)));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Manager workspaces could not be loaded.' });
});
