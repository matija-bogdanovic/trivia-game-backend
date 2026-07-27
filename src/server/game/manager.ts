import { WebSocket } from "ws";
import {
  DeleteCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";
import { queryByKey } from "../helpers/query_db.js";
import { GameRoom } from "./room.js";
import { getWallet, recordGameResult, saveWallet } from "./wallet.js";

const rooms = new Map<number, GameRoom>();

export function getLiveRoomSummaries() {
  return [...rooms.values()].map((room) => ({
    code: room.code,
    phase: room.phase,
    connectedCount: [...room.players.values()].filter((p) => p.connected)
      .length,
  }));
}

export function isUserOnline(username: string): boolean {
  for (const room of rooms.values()) {
    const p = room.players.get(username);
    if (p?.connected) return true;
  }
  return false;
}

async function getOrCreateRoom(code: number): Promise<GameRoom | null> {
  const existing = rooms.get(code);
  if (existing) return existing;

  const items = await queryByKey("Lobbies", "code", code, "code-index");
  const lobby = items[0];
  if (!lobby) return null;

  const room = new GameRoom(code, lobby.roomName ?? `Room ${code}`);
  room.lobbyId = lobby.lobby_id;
  for (const p of lobby.players ?? []) {
    room.addPlayer(String(p.player), { isHost: p.role === "Admin" });
  }
  room.onEmpty = () => rooms.delete(code);
  room.onGameOver = persistResults;
  room.onPlayerKicked = removeFromLobbyRecord;
  room.onTerminated = (r) => {
    rooms.delete(r.code);
    deleteLobbyRecord(r).catch((err) =>
      console.error("Failed to delete lobby record:", err)
    );
  };
  rooms.set(code, room);
  return room;
}

async function removeFromLobbyRecord(room: GameRoom, username: string) {
  if (!room.lobbyId) return;
  try {
    const res = await docClient.send(
      new GetCommand({ TableName: "Lobbies", Key: { lobby_id: room.lobbyId } })
    );
    const players = (res.Item?.players ?? []).filter(
      (p: any) => p.player !== username
    );
    await docClient.send(
      new UpdateCommand({
        TableName: "Lobbies",
        Key: { lobby_id: room.lobbyId },
        UpdateExpression: "SET players = :players",
        ExpressionAttributeValues: { ":players": players },
      })
    );
  } catch (err) {
    console.error("Failed to remove kicked player from lobby record:", err);
  }
}

async function deleteLobbyRecord(room: GameRoom) {
  if (!room.lobbyId) return;
  await docClient.send(
    new DeleteCommand({ TableName: "Lobbies", Key: { lobby_id: room.lobbyId } })
  );
}

async function persistResults(room: GameRoom) {
  // lifetime stats + coin rewards, regardless of lobby persistence
  const players = [...room.players.values()];
  const winner =
    [...players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.money - a.money;
    })[0]?.username ?? null;

  recordGameResult(room.getGameStats(winner))
    .then(async (unlocked) => {
      for (const [username, achievements] of unlocked) {
        room.broadcast({
          type: "achievements_unlocked",
          username,
          achievements: achievements.map((a) => ({ id: a.id, name: a.name })),
        });
        room.announce(
          `🏅 ${room.nameOf(username)} unlocked: ${achievements.map((a) => a.name).join(", ")}`
        );
      }
      // refresh lobby streak badges for the next match
      for (const p of players) {
        try {
          const wallet = await getWallet(p.username);
          room.setPlayerProfile(p.username, wallet.currentStreak, wallet.avatar);
        } catch {
          // cosmetic only
        }
      }
    })
    .catch((err) => console.error("recordGameResult failed:", err));

  if (!room.lobbyId) return;
  try {
    const players = [...room.players.values()].map((p) => ({
      id: "",
      player: p.username,
      role: p.isHost ? "Admin" : "Member",
      points: p.money,
    }));
    await docClient.send(
      new UpdateCommand({
        TableName: "Lobbies",
        Key: { lobby_id: room.lobbyId },
        UpdateExpression: "SET players = :players, #state = :state",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":players": players,
          ":state": "finished",
        },
      })
    );
  } catch (err) {
    console.error("Failed to persist game results:", err);
  }
}

export function handleGameConnection(ws: WebSocket, url: string) {
  const match = url.match(/^\/game\/(\d+)/);
  if (!match) {
    ws.send(JSON.stringify({ type: "error", message: "Unknown endpoint" }));
    ws.close();
    return;
  }
  const code = Number(match[1]);
  let room: GameRoom | null = null;

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "join") {
        const username = String(msg.username ?? "").trim();
        if (!username) {
          ws.send(
            JSON.stringify({ type: "error", message: "Username required" })
          );
          return;
        }
        room = await getOrCreateRoom(code);
        if (!room) {
          ws.send(
            JSON.stringify({ type: "error", message: "Room not found" })
          );
          ws.close();
          return;
        }
        const avatar =
          typeof msg.avatar === "string" && msg.avatar.length <= 24
            ? msg.avatar
            : null;
        const displayName =
          typeof msg.displayName === "string" && msg.displayName.trim()
            ? msg.displayName.trim().slice(0, 50)
            : null;
        room.connect(ws, username, avatar, displayName);
        // hydrate streak badge + avatar; keep the wallet's display name
        // fresh so leaderboard/friends show real names
        const joinedRoom = room;
        getWallet(username)
          .then(async (w) => {
            joinedRoom.setPlayerProfile(username, w.currentStreak, w.avatar);
            if (displayName && w.displayName !== displayName) {
              w.displayName = displayName;
              await saveWallet(w);
            }
          })
          .catch(() => {});
      } else if (room) {
        room.handleMessage(ws, msg);
      }
    } catch (err) {
      console.error("Game message error:", err);
      ws.send(
        JSON.stringify({ type: "error", message: "Internal server error" })
      );
    }
  });

  ws.on("close", () => {
    room?.disconnect(ws);
  });
}
