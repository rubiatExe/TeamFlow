const MAX_SERVICE_URL_LENGTH = 2_048;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export class ServiceUrlConfigurationError extends Error {
  constructor() {
    super('Trusted service URL is not configured');
    this.name = 'ServiceUrlConfigurationError';
  }
}

function parseOrigin(raw: string): URL {
  if (!raw || raw.length > MAX_SERVICE_URL_LENGTH || raw !== raw.trim()) {
    throw new ServiceUrlConfigurationError();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServiceUrlConfigurationError();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new ServiceUrlConfigurationError();
  }
  return url;
}

/**
 * Resolve a credential-bearing server-to-server origin.
 *
 * Production requires HTTPS and a separately configured exact trusted origin.
 * Development permits only loopback or reserved `.test` hosts unless that same
 * explicit origin is supplied. Redirects must still be disabled by the caller.
 */
export function resolveTrustedServiceBaseUrl(
  raw: string | undefined,
  trustedOrigin: string | undefined,
  environment: ServerEnvironment = process.env,
): string {
  const url = parseOrigin(raw ?? '');
  const production = environment.NODE_ENV === 'production';
  const explicitlyTrusted = trustedOrigin ? parseOrigin(trustedOrigin) : null;

  if (explicitlyTrusted && explicitlyTrusted.origin !== url.origin) {
    throw new ServiceUrlConfigurationError();
  }
  if (production) {
    if (url.protocol !== 'https:' || !explicitlyTrusted) {
      throw new ServiceUrlConfigurationError();
    }
  } else if (!explicitlyTrusted) {
    const localOrTest = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.test');
    if (!localOrTest) throw new ServiceUrlConfigurationError();
  }

  return url.origin;
}
