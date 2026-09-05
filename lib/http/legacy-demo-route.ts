const LEGACY_DEMO_ROUTES_FLAG = 'TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES';

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Legacy demo routes intentionally have no end-user authorization boundary.
 * Keep them available only for an explicitly enabled, non-production local demo.
 */
export function legacyDemoRoutesEnabled(
  environment: ServerEnvironment = process.env,
): boolean {
  return (
    (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test')
    && environment[LEGACY_DEMO_ROUTES_FLAG] === 'true'
  );
}

/** Return a response when a legacy demo route must stop before reading input. */
export function guardLegacyDemoRoute(
  environment: ServerEnvironment = process.env,
): Response | null {
  if (legacyDemoRoutesEnabled(environment)) return null;

  return Response.json(
    { error: 'Not found' },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
