import { NextFunction, Request, Response } from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";

/**
 * Identity comes from a Cognito-signed token and nowhere else.
 *
 * Every endpoint used to read `username` out of the request body, so anyone
 * could act as anyone by typing a different name. The verifier below checks
 * the token's signature against the pool's JWKS and its `iss`, `aud`/
 * `client_id`, `exp` and `token_use` claims; the username is then read off the
 * verified payload. A body-supplied username is never trusted again.
 */
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "eu-west-3_Uylh5ZFUK";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "3j69q67dfk60kl92gukqhdlr91";

/**
 * Access tokens (not id tokens) are the ones meant for an API: they carry
 * `username` and `sub`, and are scoped to this app client. Display names stay
 * client-supplied — they are cosmetic and never used as a key.
 */
export const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  clientId: CLIENT_ID,
  tokenUse: "access",
});

export interface AuthedUser {
  /** the identity key used everywhere (Cognito username) */
  username: string;
  sub: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthedUser;
}

/** pulls the bearer token off a request, if there is one */
function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!/^Bearer$/i.test(scheme ?? "") || !token) return null;
  return token.trim() || null;
}

/**
 * Verifies a raw token and returns the identity, or null when it is missing,
 * malformed, expired, signed by someone else, or issued for another client.
 * Shared by the REST middleware and the WebSocket handshake.
 */
export async function identityFromToken(
  token: string | null | undefined
): Promise<AuthedUser | null> {
  if (!token) return null;
  try {
    const payload = await jwtVerifier.verify(token);
    const username = payload.username ?? payload.sub;
    if (!username) return null;
    return { username: String(username), sub: String(payload.sub) };
  } catch {
    // invalid signature / expired / wrong issuer or client — all mean "no"
    return null;
  }
}

/** rejects the request unless it carries a valid Cognito access token */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const identity = await identityFromToken(bearerFrom(req));
  if (!identity) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  req.auth = identity;
  next();
}

/**
 * The authenticated username. Handlers call this instead of reading
 * req.body.username — it throws rather than silently falling back, so a route
 * that forgets requireAuth fails loudly instead of going unauthenticated.
 */
export function authedUsername(req: AuthedRequest): string {
  if (!req.auth?.username) {
    throw new Error("authedUsername() used on a route without requireAuth");
  }
  return req.auth.username;
}
