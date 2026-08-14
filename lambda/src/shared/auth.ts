import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

/**
 * Same rule as the Express server (src/server/middleware/auth.ts): identity
 * comes from a Cognito-signed access token and nowhere else. A body-supplied
 * username is never trusted, so uploading someone else's avatar is not a
 * thing a client can express.
 *
 * The verifier is created at module scope on purpose — it caches the pool's
 * JWKS, so only the first invocation on a cold container pays the fetch.
 */
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "eu-west-3_Uylh5ZFUK";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "3j69q67dfk60kl92gukqhdlr91";

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

/**
 * Pulls the bearer token off an API Gateway v2 event. Header names in the v2
 * payload are lower-cased by API Gateway, but a v1/REST payload would send
 * `Authorization` — check both so the handler survives either integration.
 */
function bearerFrom(event: APIGatewayProxyEventV2): string | null {
  const headers = event.headers ?? {};
  const header = headers.authorization ?? headers.Authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!/^Bearer$/i.test(scheme ?? "") || !token) return null;
  return token.trim() || null;
}

/**
 * Verifies the request's token and returns the identity, or null when it is
 * missing, malformed, expired, signed by someone else, or issued for another
 * client. Mirrors identityFromToken() on the Express side.
 */
export async function identityFromEvent(
  event: APIGatewayProxyEventV2
): Promise<AuthedUser | null> {
  const token = bearerFrom(event);
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
