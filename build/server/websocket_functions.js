import { ws } from "./connections.js";
import WebSocket from "ws";
import "dotenv/config";
export function helperFunction(props) {
    ws.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(props));
        }
    });
}
//# sourceMappingURL=websocket_functions.js.map