import { createClient } from "redis";
import { WebSocketServer } from "ws";
import http from "http";

export const client = createClient({
  username: "default",
  password: "5G7NamTUPyRPhjkbEdrXCBWXcKGVYrWa",
  socket: {
    host: "redis-18225.c339.eu-west-3-1.ec2.redns.redis-cloud.com",
    port: 18225,
  },
});
export const server = http.createServer();
export const ws = new WebSocketServer({ noServer: true });

export function attachWSServer() {
  server.on("upgrade", (req, socket, head) => {
    ws.handleUpgrade(req, socket, head, (socket) => {
      ws.emit("connection", socket, req);
    });
  });
}
