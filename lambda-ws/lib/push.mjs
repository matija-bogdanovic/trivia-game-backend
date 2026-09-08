/**
 * ===========================================================================
 * lib/push.mjs — Web Push, with nothing but node:crypto
 * ===========================================================================
 *
 * ── WHY THIS IS NOT `web-push` ─────────────────────────────────────────────
 * Both Lambdas deploy as a plain zip of .mjs files with no node_modules. That
 * is the whole shape of this project's deploy: zip, upload, done. Pulling in
 * the `web-push` package would end it — the function would need either a
 * Lambda layer or a bundler, and every future change would go through one of
 * them.
 *
 * It is not worth that, because the library is thin. Web Push is two RFCs:
 *
 *   RFC 8291  the payload encryption (ECDH P-256, HKDF-SHA256, AES-128-GCM)
 *   RFC 8188  the aes128gcm content encoding those bytes are wrapped in
 *   RFC 8292  VAPID — an ES256 JWT proving who is sending
 *
 * Node has every primitive for all three. What follows is ~150 lines against
 * a dependency, and it is verified against the RFC's own published test
 * vector rather than against itself — see scripts/push_crypto_test.mjs.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ─────────────────────────────────────
 * Two things, and both fail silently rather than loudly:
 *
 *   1. The VAPID signature must be raw R||S, 64 bytes. Node signs ECDSA as
 *      DER by default, which every push service rejects as an invalid token.
 *      `dsaEncoding: 'ieee-p1363'` is what asks for the other form.
 *
 *   2. The HKDF info strings are byte-exact, including their trailing NUL and
 *      the 0x01 counter HKDF-Expand appends. A wrong byte gives a key that
 *      encrypts perfectly and decrypts to nothing on the phone.
 */

import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const unb64url = (s) => Buffer.from(String(s), "base64url");

/** HKDF-Extract, which for our purposes is just a keyed hash */
const extract = (salt, ikm) =>
  crypto.createHmac("sha256", salt).update(ikm).digest();

/**
 * HKDF-Expand for one block. Every output we need is <= 32 bytes, so the
 * counter never goes past 0x01 and the loop the full algorithm calls for
 * would run exactly once.
 */
const expand = (prk, info, length) =>
  crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);

/** an EC key object from the raw scalar / point a VAPID pair is stored as */
function ecKeys(publicKey, privateKey) {
  const pub = unb64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed point");
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.subarray(1, 33)),
    y: b64url(pub.subarray(33, 65)),
  };
  return {
    publicKey: crypto.createPublicKey({ key: jwk, format: "jwk" }),
    privateKey: privateKey
      ? crypto.createPrivateKey({
          key: { ...jwk, d: b64url(unb64url(privateKey)) },
          format: "jwk",
        })
      : null,
  };
}

/**
 * Encrypt a payload for one subscription — RFC 8291, wrapped per RFC 8188.
 *
 * `salt` and `serverKeys` are parameters only so the test can pin them to the
 * RFC's vector; in use both are freshly generated per message, which is
 * required — reusing a salt with the same key reuses an AES-GCM nonce.
 */
function encryptPayload(payload, subscription, opts = {}) {
  const uaPublic = unb64url(subscription.keys.p256dh);
  const authSecret = unb64url(subscription.keys.auth);
  const salt = opts.salt ?? crypto.randomBytes(16);

  const server =
    opts.serverKeys ??
    (() => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      return { publicKey, privateKey };
    })();

  const asPublicRaw = server.publicKey.export({ format: "jwk" });
  const asPublic = Buffer.concat([
    Buffer.from([0x04]),
    unb64url(asPublicRaw.x),
    unb64url(asPublicRaw.y),
  ]);

  const shared = crypto.diffieHellman({
    privateKey: server.privateKey,
    publicKey: crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64url(uaPublic.subarray(1, 33)),
        y: b64url(uaPublic.subarray(33, 65)),
      },
      format: "jwk",
    }),
  });

  /*
   * The key derivation, in the order RFC 8291 §3.4 sets out. The auth secret
   * salts the FIRST extract and the message salt the second — swapping them
   * is the classic way to get a working encryptor that no browser can read.
   */
  const prkKey = extract(authSecret, shared);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = expand(prkKey, keyInfo, 32);
  const prk = extract(salt, ikm);

  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // 0x02 marks the last (here, only) record; RFC 8188 §2
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(opts.recordSize ?? 4096, 0);
  const header = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
  ]);
  return Buffer.concat([header, body]);
}

/**
 * A VAPID Authorization header for one push origin.
 *
 * The audience is the push SERVICE's origin, not the subscription path — a
 * token minted for the wrong audience is refused, and it is the same for
 * every subscription on that service, which is why it is derived here rather
 * than passed in.
 */
function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const { privateKey: key } = ecKeys(publicKey, privateKey);
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(
    JSON.stringify({
      aud,
      // twelve hours: comfortably inside the 24h ceiling RFC 8292 sets, and
      // long enough that a token is never minted twice for one send
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: subject,
    })
  );
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" } // raw R||S, not DER
  );
  return {
    Authorization: `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`,
  };
}

/**
 * Send one message to one subscription.
 *
 * Returns { ok } on success, and on failure says whether the subscription is
 * DEAD — 404 and 410 mean the browser threw it away (cleared site data,
 * unsubscribed, a very old endpoint) and it should be deleted rather than
 * retried forever. Every other failure is transient and the row stays.
 *
 * A push service is a third party that can be slow or down, so this never
 * throws: the caller is delivering a notification that is already durably
 * written, and a failed push must not take the write with it.
 */
async function sendPush(subscription, payload, vapid, timeoutMs = 6000) {
  let body;
  try {
    body = encryptPayload(payload, subscription);
  } catch (err) {
    // a malformed key on the row — it will never encrypt, so stop keeping it
    return { ok: false, dead: true, reason: `encrypt: ${err.message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        ...vapidHeader(subscription.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // how long the service should hold it for a device that is offline
        TTL: "86400",
        Urgency: "normal",
      },
      body,
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    return {
      ok: false,
      dead: res.status === 404 || res.status === 410,
      status: res.status,
      reason: await res.text().catch(() => ""),
    };
  } catch (err) {
    return { ok: false, dead: false, reason: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export {
  b64url,
  ecKeys,
  encryptPayload,
  expand,
  extract,
  sendPush,
  unb64url,
  vapidHeader,
};
