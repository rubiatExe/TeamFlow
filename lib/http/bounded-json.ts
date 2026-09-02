export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

export class InvalidJsonResponseError extends Error {
  constructor() {
    super('Response is not bounded application/json');
    this.name = 'InvalidJsonResponseError';
  }
}

export class RequestBodyDeadlineError extends Error {
  constructor() {
    super('Request body deadline exceeded');
    this.name = 'RequestBodyDeadlineError';
  }
}

type BoundedJsonOptions = {
  signal?: AbortSignal;
};

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  // Stream cancellation is best-effort cleanup. A hostile or already-failed
  // stream must never replace the typed boundary error or extend its deadline.
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Some custom stream implementations can throw before returning a promise.
  }
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(new RequestBodyDeadlineError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      reject(new RequestBodyDeadlineError());
    };
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(
      result => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        resolve(result);
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

/** Read and decode JSON while enforcing the byte limit on streamed/chunked bodies. */
export async function readBoundedJson(
  request: Pick<Request, 'body'>,
  maxBytes: number,
  options: BoundedJsonOptions = {},
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  if (!request.body) {
    throw new SyntaxError('Request body is empty');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, options.signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof RequestBodyDeadlineError ||
      error instanceof RequestBodyTooLargeError
    ) {
      cancelReader(reader);
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending custom read can temporarily retain the lock after cancellation.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

/** Validate response metadata and stream JSON under the same hard byte cap. */
export async function readBoundedJsonResponse(
  response: Pick<Response, 'body' | 'headers'>,
  maxBytes: number,
  options: BoundedJsonOptions = {},
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^[0-9]+$/u.test(contentLength)) {
      throw new InvalidJsonResponseError();
    }
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new InvalidJsonResponseError();
    }
    if (parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }
  const mediaType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new InvalidJsonResponseError();
  }
  return readBoundedJson(response, maxBytes, options);
}
