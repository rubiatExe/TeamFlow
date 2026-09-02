import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidJsonResponseError,
  readBoundedJson,
  readBoundedJsonResponse,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
} from '../../lib/http/bounded-json.ts';

function chunkedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  return new Request('http://teamflow.test/internal', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

test('reads valid chunked JSON without trusting Content-Length', async () => {
  const result = await readBoundedJson(
    chunkedRequest(['{"schema', '_version":"1.0"}']),
    64,
  );
  assert.deepEqual(result, { schema_version: '1.0' });
});

test('rejects a chunked body as soon as its actual bytes exceed the limit', async () => {
  await assert.rejects(
    readBoundedJson(chunkedRequest(['{"value":"', 'x'.repeat(80), '"}']), 64),
    RequestBodyTooLargeError,
  );
});

test('stream cancellation failures cannot replace typed limit or deadline errors', async () => {
  const oversized = new Request('http://teamflow.test/internal', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        return Promise.reject(new Error('cancel canary'));
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(
    readBoundedJson(oversized, 64),
    RequestBodyTooLargeError,
  );

  const stalled = new Request('http://teamflow.test/internal', {
    method: 'POST',
    body: new ReadableStream({
      pull() {},
      cancel() {
        return Promise.reject(new Error('cancel canary'));
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(
    readBoundedJson(stalled, 64, { signal: AbortSignal.timeout(5) }),
    RequestBodyDeadlineError,
  );
});

test('rejects malformed JSON and malformed UTF-8', async () => {
  await assert.rejects(readBoundedJson(chunkedRequest(['{"broken"']), 64), SyntaxError);

  const malformed = new Request('http://teamflow.test/internal', {
    method: 'POST',
    body: new Uint8Array([0xff]),
  });
  await assert.rejects(readBoundedJson(malformed, 64), TypeError);
});

test('bounds upstream JSON responses and requires the declared media type', async () => {
  const valid = Response.json({ ok: true });
  assert.deepEqual(await readBoundedJsonResponse(valid, 64), { ok: true });

  await assert.rejects(
    readBoundedJsonResponse(
      new Response('{"ok":true}', { headers: { 'Content-Type': 'text/plain' } }),
      64,
    ),
    InvalidJsonResponseError,
  );
  await assert.rejects(
    readBoundedJsonResponse(
      new Response('{"ok":true}', {
        headers: {
          'Content-Length': '1000',
          'Content-Type': 'application/json',
        },
      }),
      64,
    ),
    RequestBodyTooLargeError,
  );
  for (const contentLength of ['+2', '2e0', '2, 2']) {
    await assert.rejects(
      readBoundedJsonResponse(
        new Response('{"ok":true}', {
          headers: {
            'Content-Length': contentLength,
            'Content-Type': 'application/json',
          },
        }),
        64,
      ),
      InvalidJsonResponseError,
    );
  }
  await assert.rejects(
    readBoundedJsonResponse(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new Uint8Array(80));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
      64,
    ),
    RequestBodyTooLargeError,
  );
});
