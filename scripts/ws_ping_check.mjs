/**
 * ===========================================================================
 * ws_ping_check.mjs — is the deployed WebSocket handler alive?
 * ===========================================================================
 *   node scripts/ws_ping_check.mjs
 *
 * The check lambda-ws/README.md asks for after every deploy, made runnable.
 * Opens the socket, sends a ping, waits for the pong.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: a module-resolution mistake inside the
 * multi-file zip — a wrapped folder, a missed lib/ file — does not surface as
 * an error anywhere. The socket opens normally and the handler simply never
 * answers. Silence is the failure signal, which is why this has a timeout and
 * exits non-zero on it rather than hanging.
 *
 * Needs no credentials: $connect is open and `ping` is answered before any
 * join, so this verifies routing and module loading without a Cognito token.
 * It does NOT verify anything that requires being in a room.
 * ===========================================================================
 */
import WebSocket from 'ws';

const URL = 'wss://j803en0pf7.execute-api.eu-west-3.amazonaws.com/prod';
const TIMEOUT_MS = 12000;

const ws = new WebSocket(URL);
const seen = [];
let settled = false;

const done = (ok, why) => {
  if (settled) return;
  settled = true;
  console.log(`\nmessages received: ${JSON.stringify(seen)}`);
  console.log(ok ? `PASS — ${why}` : `FAIL — ${why}`);
  try {
    ws.close();
  } catch {}
  process.exit(ok ? 0 : 1);
};

const timer = setTimeout(
  () => done(false, `no pong within ${TIMEOUT_MS}ms (handler silent?)`),
  TIMEOUT_MS
);

ws.on('open', () => {
  console.log('socket OPEN');
  ws.send(JSON.stringify({ type: 'ping' }));
  console.log('sent: {"type":"ping"}');
});

ws.on('message', (raw) => {
  const text = raw.toString();
  console.log('recv:', text);
  let msg = null;
  try {
    msg = JSON.parse(text);
  } catch {
    /* record it raw below */
  }
  seen.push(msg?.type ?? text.slice(0, 40));
  if (msg?.type === 'pong') {
    clearTimeout(timer);
    done(true, 'pong received — the handler is alive and routing');
  }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  done(false, `socket error: ${err.message}`);
});

ws.on('close', (code) => {
  if (!settled) {
    clearTimeout(timer);
    done(false, `socket closed (${code}) before a pong`);
  }
});
