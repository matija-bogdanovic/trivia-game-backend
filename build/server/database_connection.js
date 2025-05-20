import { createClient } from "redis";
import { WebSocketServer } from "ws";
import express from "express";
export const client = createClient({
    username: "default",
    password: "5G7NamTUPyRPhjkbEdrXCBWXcKGVYrWa",
    socket: {
        host: "redis-18225.c339.eu-west-3-1.ec2.redns.redis-cloud.com",
        port: 18225,
    },
});
const app = express();
export const ws = new WebSocketServer({ port: 3000 });
client.on("error", (err) => console.log("Redis Client Error", err));
//# sourceMappingURL=database_connection.js.map