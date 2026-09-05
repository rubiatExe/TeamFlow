// TeamFlow crosses a browser/Next/Python trust boundary. Only W3C traceparent
// and tracestate are allowed to cross it; baggage is intentionally excluded so
// request-controlled metadata cannot become an ambient cross-service channel.
export const TEAMFLOW_OTEL_PROPAGATORS = ['tracecontext'] as const;

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  if (process.env.TEAMFLOW_OTEL_ENABLED !== 'true') {
    return;
  }

  const hasOtlpExporter = Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.VERCEL_OTEL_ENDPOINTS,
  );

  if (process.env.OTEL_SDK_DISABLED === 'true' || !hasOtlpExporter) {
    return;
  }

  const { registerOTel } = await import('@vercel/otel');
  const googleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;

  registerOTel({
    serviceName:
      process.env.NEXT_OTEL_SERVICE_NAME || 'teamflow-next-api',
    attributes: {
      'deployment.environment.name':
        process.env.ENVIRONMENT || process.env.NODE_ENV || 'development',
      'teamflow.component': 'next-api',
      ...(googleCloudProject
        ? {
            'gcp.project.id': googleCloudProject,
            'cloud.account.id': googleCloudProject,
          }
        : {}),
    },
    propagators: [...TEAMFLOW_OTEL_PROPAGATORS],
    traceSampler: 'parentbased_traceidratio',
    instrumentationConfig: {
      fetch: {
        // Do not send trace context to third parties by default. The OCR
        // boundary opts in explicitly on its individual fetch call.
        dontPropagateContextUrls: ['*'],
      },
    },
  });
}
