import { createHmac, timingSafeEqual } from 'crypto';

// ----------------------------------------------------------------------------
// Implémentation minimale de type JWT (HS256), basée uniquement sur le
// module `crypto` intégré à Node. Évite d'ajouter la dépendance
// `jsonwebtoken` pour un besoin aussi simple (signer/vérifier un couple
// { userId, tenantId } avec expiration).
// ----------------------------------------------------------------------------

export interface TokenPayload {
  userId: number;
  tenantId: number;
}

interface FullPayload extends TokenPayload {
  iat: number;
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12h

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      "JWT_SECRET doit être défini en production (variable d'environnement manquante)."
    );
  }
  // eslint-disable-next-line no-console
  console.warn('[auth] JWT_SECRET non défini — utilisation d\'un secret de développement non sécurisé.');
  return 'dev-insecure-secret-change-me';
}

export function signToken(payload: TokenPayload, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: FullPayload = { ...payload, iat: now, exp: now + ttlSeconds };

  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', getSecret())
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  return `${headerPart}.${payloadPart}.${signature}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;

  const expectedSignature = createHmac('sha256', getSecret())
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null; // signature invalide ou falsifiée
  }

  let payload: Partial<FullPayload>;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) {
    return null; // expiré
  }
  if (typeof payload.userId !== 'number' || typeof payload.tenantId !== 'number') {
    return null; // payload malformé
  }

  return { userId: payload.userId, tenantId: payload.tenantId };
}
