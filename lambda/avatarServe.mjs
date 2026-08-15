/**
 * ===========================================================================
 * avatarServe — GET /avatar/img/{username}
 * ===========================================================================
 * Streams a player's stored profile picture back. Public on purpose —
 * other players' pictures are shown all over the arena, same as the Express
 * route, which sits outside requireAuth. The bucket stays private; this
 * function is its only reader.
 *
 * Paste-ready AWS Lambda handler. NO third-party dependencies: everything
 * used here either ships in the Node.js 18/20/22 Lambda runtime (AWS SDK v3)
 * or is built into Node (node:crypto, global fetch). Paste it and it runs —
 * no layer, no zip, no `npm install`.
 *
 * ┌── PASTE INSTRUCTIONS ───────────────────────────────────────────────────┐
 * │ The console file MUST be named  index.mjs  (the .mjs extension is what  │
 * │ makes `export const handler` work). Runtime: Node.js 22.x.              │
 * │ Handler: index.handler   Timeout: 15s   Memory: 512 MB                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   AVATAR_BUCKET          ipak-se-okrece-avatars
 *   ALLOWED_ORIGIN         https://<your-vercel-domain>,http://localhost:3000
 *   AWS_REGION             set automatically by Lambda — do NOT add it by hand
 *                          (Lambda rejects reserved env var names).
 * Every one has a working default baked in below, so the function runs even
 * with no env vars set. Setting them is still the right thing to do.
 *
 * ── IAM (inline policy on this function's execution role) ──────────────────
 *   {
 *     "Version": "2012-10-17",
 *     "Statement": [
 *       { "Effect": "Allow",
 *         "Action": ["s3:GetObject"],
 *         "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  GET /avatar/img/{username}
 *   Integration:   Lambda proxy integration (HTTP API payload 2.0, or REST
 *                  "Use Lambda Proxy integration" — this handler reads both).
 *   binaryMediaTypes: ⚠ THIS IS THE ONE ROUTE WHERE IT MATTERS.
 *                  This handler returns the image base64-encoded with
 *                  isBase64Encoded: true. What happens next depends on the
 *                  API type:
 *                  • HTTP API (payload 2.0) — decodes it to raw bytes
 *                    automatically. Nothing to configure. Recommended.
 *                  • REST API — you MUST add a binary media type or the
 *                    browser gets a base64 STRING labelled image/jpeg: a
 *                    broken image, 200 status, nothing in the logs.
 *                    API settings -> Binary media types -> add the
 *                    wildcard  * / *  (typed WITHOUT the spaces), then
 *                    redeploy the stage. Use the wildcard rather than
 *                    image/jpeg: REST APIs only decode when the CLIENT's
 *                    Accept header matches a configured type, and
 *                    browsers send 'image/avif,image/webp,* / *' for
 *                    <img> tags.
 *
 * ── CORS ───────────────────────────────────────────────────────────────────
 *   This handler emits the CORS headers itself (from ALLOWED_ORIGIN) and
 *   answers the OPTIONS preflight, so a bare paste works with no API Gateway
 *   CORS configuration.
 *   ⚠ Do NOT also enable CORS in the API Gateway console — you would get
 *   duplicate Access-Control-Allow-Origin headers, which browsers reject.
 *   Either leave it off (recommended), or turn it on and set ALLOWED_ORIGIN
 *   to an empty string here.
 *
 * ── CONTRACT (matches the Express route exactly — do not change) ───────────
 *   Request:  GET /avatar/img/{username}?v=<version>
 *   Response: 200 the image bytes
 *                  Content-Type: image/jpeg (or whatever was uploaded)
 *                  Cache-Control: public, max-age=86400, immutable
 *             404 no avatar for that user
 *   The ?v= version is the cache-buster and is intentionally ignored by the
 *   server: the pointer changing in the wallet changes the URL, and the URL
 *   changing is what defeats the year-long immutable cache.
 *
 * ── NOTE ───────────────────────────────────────────────────────────────────
 *   The API Gateway path parameter MUST be named {username} — the handler
 *   reads event.pathParameters.username.
 *
 *   s3:ListBucket on the BUCKET (not the objects) is required, even though
 *   this handler never lists anything. S3 decides what a GetObject on a
 *   missing key returns based on it: with ListBucket you get NoSuchKey
 *   (404, which is what this handler maps to a clean 404); WITHOUT it S3
 *   returns AccessDenied (403) instead, so as not to reveal whether the
 *   object exists — and this handler would surface that as a 500. Verified
 *   the hard way against the live bucket. lambda/iam-policy.json grants it.
 *
 * Ported from: getAvatarImageHandler in src/server/apis/avatars.ts
 * ===========================================================================
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || "ipak-se-okrece-avatars";

// clients at module scope so warm invocations reuse the connections
const s3 = new S3Client({ region: REGION });

// ─── request/response helpers (both API Gateway payload formats) ───────────
function header(event, name) {
  const headers = event.headers || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || "GET";
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

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight, when API Gateway is not answering it for us
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  const username = event.pathParameters?.username;
  if (!username) {
    return { statusCode: 400, headers: corsHeaders(event), body: "" };
  }

  try {
    // API Gateway hands the path parameter over already percent-decoded, the
    // same as Express's req.params, so it is re-encoded here to land on the
    // exact key avatarUpload wrote. Decoding it again first would corrupt a
    // username containing a literal '%'.
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: AVATAR_BUCKET,
        Key: `avatars/${encodeURIComponent(username)}.jpg`,
      })
    );
    const bytes = await obj.Body.transformToByteArray();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": obj.ContentType || "image/jpeg",
        // versioned query string does the cache-busting
        "Cache-Control": "public, max-age=86400, immutable",
        ...corsHeaders(event),
      },
      body: Buffer.from(bytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    // SDK v3 surfaces the missing-key case as NoSuchKey; the $metadata check
    // covers the NotFound shape the error can otherwise take
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return { statusCode: 404, headers: corsHeaders(event), body: "" };
    }
    console.error("avatar fetch error:", err);
    return { statusCode: 500, headers: corsHeaders(event), body: "" };
  }
};
