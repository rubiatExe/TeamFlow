/** The applicant link is an opaque, high-entropy bearer capability. */
export function parseApplicationBearer(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
  return match?.[1] ?? null;
}

export function parseApplicationLinkToken(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
