type ServiceTokenEnvironment = Readonly<Record<string, string | undefined>>;

/** Validate shared service credentials before any credential-bearing fetch. */
export function isValidServiceToken(
  token: string | undefined,
  environment: ServiceTokenEnvironment = process.env,
): token is string {
  if (
    !token ||
    token.length > 512 ||
    token !== token.trim() ||
    !/^[\u0021-\u007e]+$/u.test(token)
  ) {
    return false;
  }
  return environment.NODE_ENV !== 'production' || token.length >= 32;
}
