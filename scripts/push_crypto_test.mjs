/**
 * ===========================================================================
 * push_crypto_test.mjs — is our Web Push encryption the real thing?
 * ===========================================================================
 *   node scripts/push_crypto_test.mjs
 *
 * Encryption that round-trips against itself proves nothing: a consistent
 * mistake decrypts perfectly and is still unreadable to a browser. So this
 * checks lib/push.mjs against the PUBLISHED vector in RFC 8291 §5 — the same
 * plaintext, keys and salt the RFC gives, and the exact ciphertext it says
 * they must produce.
 *
 * If this passes, a real push service will read what we send.
 * ===========================================================================
 */
import crypto from "node:crypto";
import { encryptPayload, vapidHeader, b64url, unb64url } from "../lambda-ws/lib/push.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       ${extra}`); }
};

/* ── RFC 8291 §5, verbatim ────────────────────────────────────────────── */
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** rebuild the RFC's application-server key pair from its raw halves */
function keyPairFrom(pub, priv) {
  const p = unb64url(pub);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: b64url(p.subarray(1, 33)),
    y: b64url(p.subarray(33, 65)),
  };
  return {
    publicKey: crypto.createPublicKey({ key: jwk, format: "jwk" }),
    privateKey: crypto.createPrivateKey({ key: { ...jwk, d: b64url(unb64url(priv)) }, format: "jwk" }),
  };
}

console.log("\nRFC 8291 §5 — the published vector");
{
  const body = encryptPayload(V.plaintext, {
    endpoint: "https://push.example.net/x",
    keys: { p256dh: V.uaPublic, auth: V.auth },
  }, {
    salt: unb64url(V.salt),
    serverKeys: keyPairFrom(V.asPublic, V.asPrivate),
  });

  ok("the ciphertext matches the RFC byte for byte",
     b64url(body) === V.expected,
     `expected ${V.expected}\n       actual   ${b64url(body)}`);

  // and the header the RFC prescribes, read back out of our own output
  ok("salt is the first 16 bytes", b64url(body.subarray(0, 16)) === V.salt);
  ok("record size is 4096", body.readUInt32BE(16) === 4096);
  ok("key id length is 65", body[20] === 65);
  ok("the server public key follows it",
     b64url(body.subarray(21, 86)) === V.asPublic);
}

console.log("\nit really decrypts on the other side");
{
  // do it the browser's way round: derive with the UA's private key
  const salt = crypto.randomBytes(16);
  const body = encryptPayload("hello arena", {
    endpoint: "https://push.example.net/x",
    keys: { p256dh: V.uaPublic, auth: V.auth },
  }, { salt });

  const asPublic = body.subarray(21, 86);
  const ua = keyPairFrom(V.uaPublic, V.uaPrivate);
  const shared = crypto.diffieHellman({
    privateKey: ua.privateKey,
    publicKey: crypto.createPublicKey({
      key: {
        kty: "EC", crv: "P-256",
        x: b64url(asPublic.subarray(1, 33)),
        y: b64url(asPublic.subarray(33, 65)),
      }, format: "jwk",
    }),
  });
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const exp = (prk, info, n) =>
    hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, n);

  const prkKey = hmac(unb64url(V.auth), shared);
  const ikm = exp(prkKey, Buffer.concat([
    Buffer.from("WebPush: info\0"), unb64url(V.uaPublic), asPublic,
  ]), 32);
  const prk = hmac(salt, ikm);
  const cek = exp(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = exp(prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  const sealed = body.subarray(86);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const out = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  ok("a fresh message decrypts back", out.subarray(0, -1).toString() === "hello arena",
     out.toString());
  ok("and carries the last-record delimiter", out[out.length - 1] === 2);
}

console.log("\nVAPID");
{
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const pub = b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)]));
  const priv = pair.privateKey.export({ format: "jwk" }).d;

  const { Authorization } = vapidHeader("https://fcm.googleapis.com/fcm/send/abc123", {
    publicKey: pub, privateKey: priv, subject: "mailto:a@b.c",
  });

  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(Authorization);
  ok("the header has the shape a push service expects", Boolean(m), Authorization);
  const [, h, c, sig, k] = m ?? [];
  ok("the key in the header is our public key", k === pub);
  ok("alg is ES256", JSON.parse(unb64url(h)).alg === "ES256");

  const claims = JSON.parse(unb64url(c));
  ok("audience is the push service ORIGIN, not the endpoint path",
     claims.aud === "https://fcm.googleapis.com", claims.aud);
  ok("it expires inside RFC 8292's 24h ceiling",
     claims.exp - Math.floor(Date.now() / 1000) <= 24 * 60 * 60);
  ok("the subject is carried", claims.sub === "mailto:a@b.c");

  ok("the signature is raw R||S, 64 bytes — not DER",
     unb64url(sig).length === 64, `${unb64url(sig).length} bytes`);
  ok("and it verifies", crypto.verify(
      "sha256", Buffer.from(`${h}.${c}`),
      { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, unb64url(sig)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
