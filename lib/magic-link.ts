import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'teamflow_dev_secret_key_change_in_prod';

export interface MagicLinkPayload {
    candidateId: string;
    candidateName: string;
    jobId?: string;
    merchantId?: string;
    merchantName?: string;
}

/**
 * Generate a magic link token for candidate portal access
 */
export function generateMagicToken(payload: MagicLinkPayload, expiresInSeconds: number = 604800): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSeconds });
}

/**
 * Verify and decode a magic link token
 */
export function verifyMagicToken(token: string): MagicLinkPayload | null {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as MagicLinkPayload;
        return decoded;
    } catch (error) {
        console.error('Invalid or expired token:', error);
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
