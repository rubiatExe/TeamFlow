import {
  context,
  isSpanContextValid,
  SpanStatusCode,
  trace,
  type Attributes,
} from '@opentelemetry/api';

const tracer = trace.getTracer('teamflow.next_pipeline', '1.0.0');

export function getActiveTraceFields(): {
  traceId?: string;
  spanId?: string;
} {
  const spanContext = trace.getSpan(context.active())?.spanContext();

  if (!spanContext || !isSpanContextValid(spanContext)) {
    return {};
  }

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

export async function withTraceSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);

    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute(
        'error.type',
        error instanceof Error ? error.name : 'UnknownError',
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
