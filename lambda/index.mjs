/**
 * ===========================================================================
 * index — router for the single-function deployment
 * ===========================================================================
 * Dispatches one Lambda across all 15 HTTP routes, so a single API Gateway
 * catch-all resource (ANY /{proxy+}) can replace 16 separately wired routes.
 *
 * This file does NOT replace the handler files — it sits beside them and calls
 * them. Each handler keeps its own env vars, auth block and behaviour, so the
 * one-function and sixteen-function layouts behave identically.
 *
 * ┌── DEPLOYMENT ───────────────────────────────────────────────────────────┐
 * │ The console cannot paste 17 files. Upload a zip whose ROOT contains this │
 * │ file plus all 16 handler .mjs files (no folder wrapping them):           │
 * │                                                                          │
 * │   cd lambda && zip -j ../ipakseokrece-lambda.zip *.mjs                   │
 * │                                                                          │
 * │ Lambda console → Code → Upload from → .zip file.                         │
 * │ Handler stays  index.handler  ·  Runtime Node.js 22.x or 24.x            │
 * │ Timeout 15s · Memory 512 MB                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── API GATEWAY (this is the part that must change) ────────────────────────
 *   ONE resource:  /{proxy+}   with method  ANY
 *   Integration:   Lambda  →  ⚠ "Use Lambda Proxy integration" MUST be ticked.
 *                  The current integration type is AWS (non-proxy), which is
 *                  why a crash surfaced as HTTP 200 with the raw error JSON:
 *                  non-proxy passes the function's return value through as the
 *                  body and ignores statusCode and headers entirely. Nothing
 *                  below works until that box is ticked.
 *   Binary:        API settings → Binary media types → add the wildcard
 *                  (asterisk slash asterisk, no spaces) for GET /avatar/img/*.
 *   Then:          Actions → Deploy API → stage `prod`.
 *
 *   ANY /{proxy+} also delivers OPTIONS here, which is what makes the CORS
 *   preflight work — this router answers it directly (204 + CORS headers)
 *   without waking a route handler.
 *
 * ── ENVIRONMENT VARIABLES ──────────────────────────────────────────────────
 *   The union of every handler's needs, on this one function:
 *     ALLOWED_ORIGIN, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID,
 *     WALLETS_TABLE, LOBBIES_TABLE, MATCHES_TABLE, AVATAR_BUCKET
 *   All have working defaults. Do NOT set AWS_REGION (reserved).
 *
 * ── IAM ────────────────────────────────────────────────────────────────────
 *   One role with lambda/iam-policy.json — already the consolidated union, so
 *   nothing changes for this layout.
 *
 * ── ROUTES ─────────────────────────────────────────────────────────────────
 *   POST /avatar                 GET  /avatar/img/{username}
 *   POST /wallet                 GET  /lobbies
 *   POST /shop/buy               GET  /leaderboard
 *   POST /friends/list           GET  /getActiveRooms
 *   POST /friends/action         POST /matches/detail
 *   POST /createRoom             POST /myActiveRoom
 *   POST /joinRoom               POST /leaveRoom
 *   POST /getRoomDetails
 *
 *   /getRoomCode is deliberately absent: the Lobbies table has no admin-index
 *   and createRoom never writes the `admin` attribute it queries, so the route
 *   cannot work. It falls through to 404 here. See lambda/README.md.
 * ===========================================================================
 */

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";

/** method + path -> handler module. Lazily imported so a cold start only
 *  parses the one handler it needs, not all sixteen. */
const ROUTES = {
  "POST /avatar": "./avatarUpload.mjs",
  "POST /wallet": "./wallet.mjs",
  "POST /shop/buy": "./shopBuy.mjs",
  "POST /friends/list": "./friendsList.mjs",
  "POST /friends/action": "./friendsAction.mjs",
  "POST /matches/detail": "./matchDetail.mjs",
  "POST /myActiveRoom": "./myActiveRoom.mjs",
  "POST /createRoom": "./createRoom.mjs",
  "POST /joinRoom": "./joinRoom.mjs",
  "POST /leaveRoom": "./leaveRoom.mjs",
  "POST /getRoomDetails": "./getRoomDetails.mjs",
  "GET /lobbies": "./lobbies.mjs",
  "GET /leaderboard": "./leaderboard.mjs",
  "GET /getActiveRooms": "./getActiveRooms.mjs",
};

/** GET /avatar/img/<username> — the only route with a path parameter */
const AVATAR_IMG = /^\/avatar\/img\/(.+)$/;

const loaded = new Map();
async function handlerFor(file) {
  if (!loaded.has(file)) loaded.set(file, (await import(file)).handler);
  return loaded.get(file);
}

// ─── shared with every handler: identical CORS behaviour ───────────────────
function header(event, name) {
  const headers = event.headers || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** echo back the caller's origin when it is on the allowed list */
function corsHeaders(event) {
  if (!ALLOWED_ORIGIN) return {}; // API Gateway is handling CORS instead
  const allowed = ALLOWED_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  const origin = header(event, "origin");
  const match = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/**
 * The request path, stage-stripped and without a trailing slash.
 *
 * REST API (payload 1.0) puts the stage-less path in `event.path`; HTTP API
 * (payload 2.0) uses `event.rawPath`, which DOES include a named stage. Both
 * are percent-encoded, which is what the avatar route wants — it decodes the
 * username itself, exactly once, the way a named {username} parameter would.
 * `pathParameters.proxy` is only a fallback: API Gateway hands that over
 * already decoded, so using it as the primary source would double-decode a
 * username containing a literal '%'.
 */
function requestPath(event) {
  let path = event.rawPath ?? event.path;
  if (!path) {
    const proxy = event.pathParameters?.proxy;
    path = typeof proxy === "string" ? "/" + proxy.replace(/^\/+/, "") : "/";
  }
  const stage = event.requestContext?.stage;
  if (stage && stage !== "$default" && path.startsWith(`/${stage}/`)) {
    path = path.slice(stage.length + 1);
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || "GET";
}

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = methodOf(event);
  const path = requestPath(event);

  // one ANY /{proxy+} route means preflight lands here — answer it directly
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  const file = ROUTES[`${method} ${path}`];
  if (file) return (await handlerFor(file))(event);

  const img = method === "GET" && AVATAR_IMG.exec(path);
  if (img) {
    // hand the sub-handler the same shape a named {username} parameter gives
    const serve = await handlerFor("./avatarServe.mjs");
    return serve({
      ...event,
      pathParameters: { ...event.pathParameters, username: decodeURIComponent(img[1]) },
    });
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json", ...corsHeaders(event) },
    body: JSON.stringify({ message: `No route for ${method} ${path}` }),
  };
};
