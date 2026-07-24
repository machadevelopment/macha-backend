import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from './env';

// WorkOS/AuthKit JWTs are verified against JWKS per request. No passwords anywhere.
const jwks = env.workosJwksUrl ? createRemoteJWKSet(new URL(env.workosJwksUrl)) : null;

export interface VerifiedToken extends JWTPayload {
  sub: string; // workos_user_id
}

export async function verifyToken(token: string): Promise<VerifiedToken> {
  if (!jwks) throw new Error('WORKOS_JWKS_URL not configured');
  const { payload } = await jwtVerify(token, jwks);
  return payload as VerifiedToken;
}
