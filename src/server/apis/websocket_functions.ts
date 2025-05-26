import { ws } from "../middleware/database_conn/redis/connection.js";
import WebSocket from "ws";
import "dotenv/config";

export function helperFunction(props: Object) {
  ws.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(props));
    }
  });
}
