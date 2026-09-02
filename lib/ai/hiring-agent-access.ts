import { createHash, timingSafeEqual } from 'node:crypto';

import { isValidServiceToken } from '../http/service-token.ts';

export type HiringAgentAccessFailure = {
  error: string;
  status: 401 | 503;
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function authorizeHiringAgentRoute(
  headers: Headers,
): HiringAgentAccessFailure | null {
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    return { error: 'Hiring-agent route is disabled', status: 503 };
  }
  if (process.env.HIRING_AGENT_ENABLED !== 'true') {
    return { error: 'Hiring-agent route is disabled', status: 503 };
  }

  const configuredToken = process.env.HIRING_AGENT_ROUTE_TOKEN;
  if (!isValidServiceToken(configuredToken)) {
    return { error: 'Hiring-agent route authentication is not configured', status: 503 };
  }

  const providedToken = headers.get('x-hiring-agent-access-token') ?? '';
  if (!constantTimeEqual(providedToken, configuredToken)) {
    return { error: 'Unauthorized', status: 401 };
  }
  return null;
}
