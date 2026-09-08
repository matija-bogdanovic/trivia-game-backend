/**
 * ===========================================================================
 * lib/notify.mjs — one event, two deliveries
 * ===========================================================================
 * Every notification in this app goes through here, and here does two things
 * in a fixed order: WRITE the durable row, then push to whatever sockets the
 * recipient happens to have open.
 *
 * ── WHY THE WRITE COMES FIRST ──────────────────────────────────────────────
 * The socket is the fast path, not the record. If the push succeeds and the
 * write fails, the notification exists only in a tab that will be closed —
 * gone on reload, and the bell will disagree with what the user just saw. The
 * other way round costs nothing: the row is there, and the next page load
 * shows it.
 *
 * So a failed WRITE is reported to the caller; a failed PUSH is not. Being
 * unable to reach a socket is the normal state of most users most of the time.
 *
 * ── ONLINE AND OFFLINE ARE THE SAME CALL ───────────────────────────────────
 * There is no branch on presence. Somebody reading the site gets the row and
 * the live message; somebody away gets the row and nothing else, and finds it
 * in the bell when they come back. That is the whole point of the durable
 * half, and it is why the invite handler no longer refuses when a friend is
 * offline — it just cannot pop a banner at them.
 *
 * ── THE SHAPE IS THE SAME ON BOTH SIDES ────────────────────────────────────
 * The object written to DynamoDB and the object pushed over the socket are
 * built once and shared, so a notification that arrives live and the same one
 * re-read after a reload are indistinguishable to the client. A UI that had to
 * handle two shapes for one thing would grow two bugs for every one fixed.
 * ===========================================================================
 */

import crypto from "node:crypto";
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import {
  CONNECTIONS_TABLE,
  NOTIFICATIONS_TABLE,
  NOTIFICATION_TTL_DAYS,
  PUSH_SUBSCRIPTIONS_TABLE,
  PUSH_SUBSCRIPTIONS_INDEX,
  vapidConfig,
} from "./config.mjs";
import { postTo } from "./connections.mjs";
import { sendPush } from "./push.mjs";

/** `<epoch ms>#<8 hex>` — ordered by time, unique within the millisecond */
function notificationId(at) {
  return `${at}#${crypto.randomBytes(4).toString("hex")}`;
}

/** every live socket belonging to one player */
async function socketsFor(username) {
  const res = await ddb.send(
    new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "username" },
      ExpressionAttributeValues: { ":u": username },
      ProjectionExpression: "connectionId",
    })
  );
  return res.Items ?? [];
}

/**
 * Send one notification.
 *
 * `kind` is what the client switches on to draw the row and decide what a
 * click does — "room_invite" is the first. `data` is whatever that kind needs
 * and nothing more; the client owns the wording, so no display string is
 * stored. A translated sentence written into the table would be frozen in the
 * language the sender happened to be reading.
 *
 * Returns the notification, or null if the durable write failed.
 */
async function notify(event, { username, kind, data = {}, at = Date.now() }) {
  if (!username || !kind) return null;

  const notification = {
    id: notificationId(at),
    kind: String(kind),
    at,
    read: false,
    data,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: NOTIFICATIONS_TABLE,
        Item: {
          username: String(username),
          notification_id: notification.id,
          at,
          kind: notification.kind,
          read: false,
          data,
          expiresAt:
            Math.floor(at / 1000) + NOTIFICATION_TTL_DAYS * 24 * 60 * 60,
        },
      })
    );
  } catch (err) {
    console.error("notification write failed", username, err?.name ?? err);
    return null;
  }

  // best effort from here: the record already exists
  let hadSocket = false;
  try {
    const sockets = await socketsFor(username);
    hadSocket = sockets.length > 0;
    await Promise.all(
      sockets.map((s) =>
        postTo(event, s.connectionId, { type: "notification", ...notification })
      )
    );
  } catch (err) {
    console.error("notification push failed", username, err?.name ?? err);
  }

  /*
   * ── AND THE THIRD DELIVERY: THE OPERATING SYSTEM ──────────────────────────
   *
   * Only when there was no socket. A web push wakes a service worker and puts
   * a banner on the desktop or the phone, which is exactly right for somebody
   * who is not here and exactly wrong for somebody who is — the in-app banner
   * has already told them, and a second one from the OS is noise the browser
   * shows behind the tab they are looking at.
   *
   * Best effort like the socket half, for the same reason: the row is already
   * written and a push service being slow is not a reason to fail a
   * notification. The one thing it DOES act on is a dead subscription — 404 or
   * 410 mean the browser threw it away, and keeping the row would mean trying
   * forever.
   */
  if (!hadSocket) {
    try {
      await pushToDevices(username, notification);
    } catch (err) {
      console.error("web push failed", username, err?.name ?? err);
    }
  }

  return notification;
}

/** every browser this player has allowed notifications on */
async function subscriptionsFor(username) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: PUSH_SUBSCRIPTIONS_TABLE,
      IndexName: PUSH_SUBSCRIPTIONS_INDEX,
      KeyConditionExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "username" },
      ExpressionAttributeValues: { ":u": String(username) },
    })
  );
  return res.Items ?? [];
}

/**
 * Fan the notification out to the player's registered browsers.
 *
 * The payload is the same object the socket carries, so the service worker
 * and the in-app client read one shape. It is small on purpose — a push
 * payload has a hard size limit around 4KB once encrypted, and `data` here is
 * ids and names, never prose.
 */
async function pushToDevices(username, notification) {
  const vapid = vapidConfig();
  if (!vapid) return; // no keys configured — nothing to send with

  const subs = await subscriptionsFor(username);
  if (!subs.length) return;

  const results = await Promise.all(
    subs.map(async (row) => {
      /*
       * Built per row, because the language is per BROWSER — the same person
       * may read the site in Serbian on a laptop and English on a phone, and
       * the banner is drawn by the worker on each.
       */
      const payload = JSON.stringify({
        type: "notification",
        ...notification,
        lang: row.lang === "en" ? "en" : "sr",
      });
      const result = await sendPush(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        vapid
      );
      return { row, result };
    })
  );

  const dead = results.filter((r) => r.result.dead);
  await Promise.all(
    dead.map(({ row }) =>
      ddb
        .send(
          new DeleteCommand({
            TableName: PUSH_SUBSCRIPTIONS_TABLE,
            Key: { endpoint: row.endpoint },
          })
        )
        .catch(() => {})
    )
  );
  if (dead.length) {
    console.log(`dropped ${dead.length} dead push subscription(s) for ${username}`);
  }
}

export { notify, notificationId, pushToDevices, subscriptionsFor };
