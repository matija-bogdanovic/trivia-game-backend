import WebSocket, { WebSocketServer } from "ws";

// Function to send a message to all connected clients
export function broadcastMessage(wss: WebSocketServer, data: any): void {
  const message = typeof data === "string" ? data : JSON.stringify(data);
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
