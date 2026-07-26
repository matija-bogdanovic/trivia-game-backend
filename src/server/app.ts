import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import router from "./apis/operations.js";
import session from "express-session";
import { createServer } from "http";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WebSocketServer } from "ws";
import { handleGameConnection } from "./game/manager.js";
import { Client, Issuer } from "openid-client";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { client as ddbClient } from "./middleware/database_conn/dynamodb/connection.js";

let oidcClient: Client;
// Initialize OpenID Client (Cognito)
async function initializeOidcClient() {
  const issuerUrl = process.env.COGNITO_ISSUER as string;
  const clientId = process.env.COGNITO_CLIENT_ID as string;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET as string;
  const redirectUri = process.env.COGNITO_REDIRECT_URI as string;

  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
    console.error("Missing Cognito OIDC environment variables");
    return;
  }

  const issuer = await Issuer.discover(issuerUrl);
  oidcClient = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });
}

const checkAuth = (req: any, res: any, next: any) => {
  req.isAuthenticated = Boolean(req.session && req.session.userInfo);
  next();
};
initializeOidcClient().catch(console.error);
export const app = express();
const server = createServer(app);
export const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});

wss.on("connection", (ws, request) => {
  // heartbeat: a client that misses two pings gets terminated, which fires
  // its 'close' handler and frees the game from waiting on a dead socket
  (ws as any).isAlive = true;
  ws.on("pong", () => {
    (ws as any).isAlive = true;
  });
  handleGameConnection(ws, request.url ?? "");
});

const HEARTBEAT_INTERVAL_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) {
      ws.terminate();
      continue;
    }
    (ws as any).isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(heartbeat));

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_ORIGIN,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
  })
);

export const docClient = DynamoDBDocumentClient.from(ddbClient as unknown as DynamoDBClient);

// Auth routes
app.get("/auth/login", async (req: any, res: any) => {
  try {
    if (!oidcClient) return res.status(500).send("OIDC not initialized");
    const authorizationUrl = oidcClient.authorizationUrl({
      scope: "openid email profile",
    });
    return res.redirect(authorizationUrl);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Auth error");
  }
});

app.get("/auth/callback", async (req: any, res: any) => {
  try {
    if (!oidcClient) return res.status(500).send("OIDC not initialized");
    const params = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(
      process.env.COGNITO_REDIRECT_URI as string,
      params,
      {}
    );
    const userInfo = await oidcClient.userinfo(tokenSet.access_token as string);
    req.session.userInfo = userInfo;
    const frontend = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
    return res.redirect(frontend);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Auth callback error");
  }
});

app.get("/auth/me", checkAuth, (req: any, res: any) => {
  return res.json({ isAuthenticated: req.isAuthenticated, user: req.session?.userInfo || null });
});

app.post("/auth/logout", (req: any, res: any) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    return res.json({ ok: true });
  });
});

app.use("/", router);

server.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
