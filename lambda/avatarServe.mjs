/**
 * ============================================================================
 * avatarServe — GET /avatar/img/{username}?v=<version>
 * ============================================================================
 * Paste-ready AWS Lambda handler. NO third-party dependencies: @aws-sdk/client-s3
 * ships in the Node.js 18/20/22 Lambda runtime. Paste it and it runs — no
 * layer, no zip, no `npm install`.
 *
 * ┌── PASTE INSTRUCTIONS ────────────────────────────────────────────────────┐
 * │ The console file MUST be named  index.mjs  (the .mjs extension is what   │
 * │ makes `export const handler` work). Runtime: Node.js 22.x.               │
 * │ Handler: index.handler   Timeout: 15s   Memory: 512 MB                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   AVATAR_BUCKET   ipak-se-okrece-avatars
 *   ALLOWED_ORIGIN  https://<your-vercel-domain>   (see CORS below)
 *   AWS_REGION      set automatically by Lambda — do NOT add it by hand
 *                   (Lambda rejects reserved env var names). Set
 *                   AVATAR_BUCKET_REGION only if the bucket is in a different
 *                   region than this function.
 * Both have working defaults baked in below, so the function runs even with no
 * env vars set. Setting them is still the right thing to do.
 *
 * This endpoint is deliberately PUBLIC — no token required — because other
 * players' pictures are shown all over the arena. That matches the Express
 * route, which sits outside requireAuth. The S3 bucket itself stays private;
 * this function is the only reader.
 *
 * ── IAM PERMISSIONS (attach to this function's execution role) ─────────────
 *   {
 *     "Version": "2012-10-17",
 *     "Statement": [
 *       { "Effect": "Allow",
 *         "Action": "s3:GetObject",
 *         "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*" }
 *     ]
 *   }
 *   Plus the AWSLambdaBasicExecutionRole managed policy for CloudWatch logs.
 *   s3:ListBucket is deliberately omitted: without it, a GetObject on a key
 *   this role CAN read still returns a clean NoSuchKey (-> 404) when the object
 *   is missing, which is exactly what this handler expects.
 *
 * ── API GATEWAY — THE BINARY SETTING, READ THIS ────────────────────────────
 *   Route/Method:  GET /avatar/img/{username}
 *                  The path parameter MUST be named {username} (REST API) or
 *                  {username} (HTTP API) — the handler reads
 *                  event.pathParameters.username.
 *   Integration:   Lambda proxy integration (HTTP API payload 2.0, or REST
 *                  "Use Lambda Proxy integration" — this handler reads both).
 *
 *   This handler returns the image base64-encoded with isBase64Encoded: true.
 *   What API Gateway does with that depends on which API type you built:
 *
 *   • HTTP API (payload format 2.0)  — RECOMMENDED, and what "Add trigger ->
 *     API Gateway -> HTTP API" creates. It decodes isBase64Encoded responses
 *     to raw bytes automatically. There is no binaryMediaTypes setting and
 *     nothing to configure. Done.
 *
 *   • REST API — you MUST add binary media types, or the browser receives a
 *     base64 STRING labelled image/jpeg: a broken image, with a 200 status and
 *     nothing in the logs to explain it.
 *       API Gateway console -> your API -> API settings -> Binary media types
 *       -> Add binary media type -> enter:  * / *      (without the spaces)
 *     Use `* / *` rather than `image/jpeg`: REST APIs only apply the decoding
 *     when the CLIENT's Accept header matches a configured type, and browsers
 *     send things like "image/avif,image/webp,*\/*" for <img> tags. `* / *`
 *     sidesteps that matching rule entirely. After changing it you must
 *     redeploy the stage (Actions -> Deploy API).
 *
 * ── CORS ───────────────────────────────────────────────────────────────────
 *   This handler emits the CORS headers itself (driven by ALLOWED_ORIGIN), so
 *   a bare paste works with no API Gateway CORS configuration.
 *   ⚠ If you ALSO turn on CORS in the API Gateway console you get duplicate
 *   Access-Control-Allow-Origin headers, which browsers reject. Pick one:
 *   leave API Gateway CORS off (recommended), or turn it on and set
 *   ALLOWED_ORIGIN to the empty string here.
 *   Note that a plain <img src> tag is not actually a CORS request, so the
 *   images render either way — the headers matter only if the frontend ever
 *   fetch()es an avatar.
 *
 * ── CONTRACT (must match the frontend exactly — do not change) ─────────────
 *   Request:  GET /avatar/img/{username}?v=<version>
 *   Response: 200 the image bytes
 *                 Content-Type: image/jpeg (or whatever was uploaded)
 *                 Cache-Control: public, max-age=86400, immutable
 *             404 no avatar for that user
 *             500 anything else
 *   The ?v= version is the cache-buster and is intentionally ignored by the
 *   server: the pointer changing in the wallet is what changes the URL, and
 *   the URL changing is what defeats the year-long immutable cache.
 * ============================================================================
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// ─── config ────────────────────────────────────────────────────────────────
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || "ipak-se-okrece-avatars";
const REGION =
  process.env.AVATAR_BUCKET_REGION || process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";

// client at module scope so warm invocations reuse the connection
const s3 = new S3Client({ region: REGION });

// ─── helpers ───────────────────────────────────────────────────────────────

/** header lookup that works for both API Gateway payload formats */
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || "GET";
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
