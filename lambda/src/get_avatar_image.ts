import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { AVATAR_BUCKET, avatarKey, s3 } from "./shared/avatars.js";

/**
 * GET /avatar/img/{username}?v=<version>
 *
 * Public on purpose — other players' pictures are shown all over the arena,
 * same as the Express route, which sits outside requireAuth.
 *
 * The bucket stays private; this handler is the only reader. The response is
 * returned base64-encoded with `isBase64Encoded: true`, which an HTTP API
 * (payload format 2.0) decodes back to raw bytes on the way out. On a REST
 * API the same response also needs `image/*` in the API's binaryMediaTypes —
 * see template.yaml and docs/lambda-avatars.md.
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const username = event.pathParameters?.username;
  if (!username) return { statusCode: 400, body: "" };

  try {
    // API Gateway hands the path parameter over already percent-decoded, the
    // same as Express's req.params, so it goes into avatarKey() raw — that
    // re-encodes it and lands on the exact key the upload wrote. Decoding it
    // again here would corrupt a username containing a literal '%'.
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: AVATAR_BUCKET,
        Key: avatarKey(username),
      })
    );
    const bytes = await obj.Body!.transformToByteArray();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": obj.ContentType ?? "image/jpeg",
        // versioned query string does the cache-busting
        "Cache-Control": "public, max-age=86400, immutable",
      },
      body: Buffer.from(bytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err: any) {
    // v3 surfaces the missing-key case as NoSuchKey; a 404 in $metadata covers
    // the NotFound shape a HeadObject-style error can take
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return { statusCode: 404, body: "" };
    }
    console.error("avatar fetch error:", err);
    return { statusCode: 500, body: "" };
  }
};
