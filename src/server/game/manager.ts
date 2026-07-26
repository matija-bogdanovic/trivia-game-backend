import { WebSocket } from "ws";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";
import { queryByKey } from "../helpers/query_db.js";
import { GameRoom } from "./room.js";

const rooms = new Map<number, GameRoom>();

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
  rooms.set(code, room);
  return room;
}

async function persistResults(room: GameRoom) {
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
        room.connect(ws, username);
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
