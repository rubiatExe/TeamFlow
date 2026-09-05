import jwt from 'jsonwebtoken';

import { legacyDemoRoutesEnabled } from '../http/legacy-demo-route.ts';

const DEMO_JWT_SECRET = 'teamflow_local_demo_secret_never_for_production';
const TOKEN_ISSUER = 'teamflow-local-demo';
const TOKEN_AUDIENCE = 'teamflow-candidate-portal-demo';

function resolveJwtSecret(): string | null {
    if (!legacyDemoRoutesEnabled()) return null;
    const configured = process.env.JWT_SECRET;
    if (configured && configured.length >= 32 && configured === configured.trim()) {
        return configured;
    }
    return DEMO_JWT_SECRET;
}

export interface MagicLinkPayload {
    candidateId: string;
    candidateName: string;
    jobId?: string;
    merchantId?: string;
    merchantName?: string;
    roleId?: string;
}

/**
 * Generate a magic link token for candidate portal access
 */
export function generateMagicToken(payload: MagicLinkPayload, expiresInSeconds: number = 604800): string {
    const secret = resolveJwtSecret();
    if (!secret) throw new Error('Magic-link demo is not configured');
    return jwt.sign(payload, secret, {
        algorithm: 'HS256',
        audience: TOKEN_AUDIENCE,
        expiresIn: expiresInSeconds,
        issuer: TOKEN_ISSUER,
    });
}

/**
 * Verify and decode a magic link token
 */
export function verifyMagicToken(token: string): MagicLinkPayload | null {
    const secret = resolveJwtSecret();
    if (!secret) return null;
    try {
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256'],
            audience: TOKEN_AUDIENCE,
            issuer: TOKEN_ISSUER,
        }) as MagicLinkPayload;
        return decoded;
    } catch (error) {
        console.warn('[Magic Link] Token validation failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        return null;
    }
}

/**
 * Generate the full magic link URL
 */
export function generateMagicLink(payload: MagicLinkPayload, baseUrl?: string): string {
    const token = generateMagicToken(payload);
    const base = baseUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    return `${base}/apply?token=${token}`;
}
