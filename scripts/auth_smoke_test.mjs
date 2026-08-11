// End-to-end auth regression check. Boots the real Express app + WS server
// in-process, primes the verifier with a locally generated JWKS (standing in
// for the pool's signing keys), and drives the real routes with real tokens.
//
// Full matrix, including the success path:
//   TEST_POOL=1 PORT=3055 COGNITO_USER_POOL_ID=eu-west-3_TESTPOOL \
//     COGNITO_CLIENT_ID=test-client-id node scripts/auth_smoke_test.mjs
//
// Rejection matrix against the real pool config the deployed server uses:
//   PORT=3056 node scripts/auth_smoke_test.mjs
//
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import WebSocket from 'ws';

const TEST_MODE = process.env.TEST_POOL === '1';
const PORT = process.env.PORT;
const POOL = process.env.COGNITO_USER_POOL_ID ?? 'eu-west-3_Uylh5ZFUK';
const CLIENT = process.env.COGNITO_CLIENT_ID ?? '3j69q67dfk60kl92gukqhdlr91';
const ISS = `https://cognito-idp.eu-west-3.amazonaws.com/${POOL}`;
const USER = 'auth_probe_user';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key-1';
jwk.alg = 'RS256';
jwk.use = 'sig';

// a second, unrelated key — the "attacker" who signs their own tokens
const attacker = await generateKeyPair('RS256');

async function mint(overrides = {}, key = privateKey) {
  const {
    iss = ISS,
    client_id = CLIENT,
    token_use = 'access',
    username = USER,
    sub = 'sub-' + USER,
    exp = Math.floor(Date.now() / 1000) + 600,
    ...rest
  } = overrides;
  return new SignJWT({ client_id, token_use, username, sub, ...rest })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(iss)
    .setExpirationTime(exp)
    .sign(key);
}

const { app } = await import('../build/server/app.js');
const { jwtVerifier } = await import('../build/server/middleware/auth.js');
if (TEST_MODE) {
  // stands in for the network fetch of the pool's real JWKS
  jwtVerifier.cacheJwks({ keys: [jwk] });
}

await new Promise((r) => setTimeout(r, 1500)); // let app.js bind its port

const BASE = `http://localhost:${PORT}`;
let pass = 0,
  fail = 0;

async function check(name, expectStatus, { token, body = {}, path = '/wallet' }) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res, text;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    console.log(`  ✗ ${name}: request failed ${e.message}`);
    fail++;
    return null;
  }
  const ok = res.status === expectStatus;
  console.log(
    `  ${ok ? '✓' : '✗'} ${name} → ${res.status} (want ${expectStatus})` +
      (ok ? '' : `  body=${text.slice(0, 120)}`)
  );
  ok ? pass++ : fail++;
  return text;
}

console.log(`\n=== REST (${TEST_MODE ? 'test pool + cached JWKS' : 'PRODUCTION pool config'}) ===`);

await check('no Authorization header', 401, {});
await check('garbage token', 401, { token: 'not-a-jwt' });
await check('token signed by an attacker key', 401, {
  token: await mint({}, attacker.privateKey),
});
await check('expired token', 401, {
  token: await mint({ exp: Math.floor(Date.now() / 1000) - 60 }),
});
await check('wrong audience / client_id', 401, {
  token: await mint({ client_id: 'some-other-client' }),
});
await check('wrong issuer', 401, {
  token: await mint({ iss: 'https://evil.example.com/pool' }),
});
await check('id token used as access token', 401, {
  token: await mint({ token_use: 'id' }),
});
await check('body claims another username, no token', 401, {
  body: { username: 'google_102423539068846880779' },
});

if (TEST_MODE) {
  const good = await mint();
  const walletBody = await check('valid token', 200, { token: good });
  await check('valid token on /friends/list', 200, {
    token: good,
    path: '/friends/list',
  });
  // identity must come from the token, not the body
  const spoofed = await check('valid token + spoofed body username', 200, {
    token: good,
    body: { username: 'google_102423539068846880779' },
  });
  const mineOk = walletBody && spoofed && walletBody === spoofed;
  console.log(
    `  ${mineOk ? '✓' : '✗'} spoofed body ignored (identical response either way)`
  );
  mineOk ? pass++ : fail++;

  console.log('\n=== WebSocket join ===');
  const wsCheck = (name, joinMsg, expectFn) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/game/probe-room-id`);
      const done = (ok, detail) => {
        console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` → ${detail}` : ''}`);
        ok ? pass++ : fail++;
        try { ws.close(); } catch {}
        resolve();
      };
      const timer = setTimeout(() => done(false, 'timed out'), 8000);
      ws.on('open', () => ws.send(JSON.stringify(joinMsg)));
      ws.on('message', (raw) => {
        clearTimeout(timer);
        const msg = JSON.parse(raw.toString());
        done(expectFn(msg), JSON.stringify(msg).slice(0, 90));
      });
      ws.on('error', () => { clearTimeout(timer); done(false, 'socket error'); });
    });

  await wsCheck(
    'join without a token is denied',
    { type: 'join', username: 'google_102423539068846880779' },
    (m) => m.type === 'join_denied' && m.reason === 'unauthenticated'
  );
  await wsCheck(
    'join with an attacker-signed token is denied',
    { type: 'join', token: await mint({}, attacker.privateKey) },
    (m) => m.type === 'join_denied' && m.reason === 'unauthenticated'
  );
  await wsCheck(
    'join with a valid token passes auth',
    { type: 'join', token: await mint() },
    // gets past auth into room lookup; the probe room does not exist
    (m) => m.type !== 'join_denied'
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
