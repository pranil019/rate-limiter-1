/**
 * limiter-service/server.js
 *
 * A single node of a distributed rate limiter.
 *
 * Distributed systems concepts demonstrated in this file:
 *  - Middleware role: this service sits between the API gateway and the
 *    backend, transparently enforcing a policy neither side implements.
 *  - RPC-style communication: POST /check is a synchronous request/response
 *    call the gateway makes for every incoming request ("may I proceed?").
 *  - Message-oriented / P2P communication: every decision this node makes
 *    is published on a Redis pub/sub channel. Other limiter nodes AND the
 *    monitoring dashboard subscribe to that channel — no node talks
 *    directly to another, they just broadcast and listen (gossip-style).
 *  - Stream-oriented communication: the WebSocket endpoint pushes a live,
 *    continuous stream of allow/deny events to any connected dashboard.
 *  - WebRTC (Unit 2): this node also acts as a *signaling relay* so two
 *    dashboard browsers can open a direct peer-to-peer RTCDataChannel
 *    with each other. The server only forwards small handshake messages
 *    (offer/answer/ICE candidates) — once connected, the actual peer
 *    traffic (shared notes) flows browser-to-browser, NOT through this
 *    server. This is the correct, honest use of WebRTC: a direct P2P
 *    data channel, with the server used only for the bootstrap step
 *    peers cannot do without (they don't know how to find each other).
 *  - Fault tolerance / design issue: if Redis (shared state) is
 *    unreachable, the node degrades to a documented fail-open policy
 *    instead of crashing or blocking all traffic.
 */

const express = require("express");
const http = require("http");
const Redis = require("ioredis");
const { WebSocketServer } = require("ws");

const NODE_ID = process.env.NODE_ID || `node-${process.pid}`;
const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Token bucket parameters (per rate-limited key, e.g. an API key or user id)
const BUCKET_CAPACITY = parseInt(process.env.BUCKET_CAPACITY || "10", 10); // max tokens
const REFILL_RATE = parseFloat(process.env.REFILL_RATE || "2"); // tokens added per second

const EVENTS_CHANNEL = "rl:events"; // decisions broadcast to peers + dashboard

const app = express();
app.use(express.json());

const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
const redisPub = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
let redisHealthy = true;

redis.on("error", () => { redisHealthy = false; });
redis.on("connect", () => { redisHealthy = true; });

/**
 * Atomic token-bucket check-and-consume, implemented as a Lua script so the
 * read-modify-write happens as a single atomic operation on the Redis node
 * even though many limiter instances may call it concurrently.
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill_rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call("HMSET", key, "tokens", tokens, "ts", now)
redis.call("EXPIRE", key, 3600)

return { allowed, tokens }
`;

async function checkRateLimit(limitKey) {
  const now = Date.now() / 1000;

  if (!redisHealthy) {
    // Design decision: fail OPEN. Under a partition from shared state we
    // choose availability over strict correctness — documented trade-off,
    // see README "Design Issues".
    return { allowed: true, remaining: null, degraded: true };
  }

  try {
    const [allowed, tokensLeft] = await redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      `bucket:${limitKey}`,
      BUCKET_CAPACITY,
      REFILL_RATE,
      now
    );
    return { allowed: allowed === 1, remaining: Number(tokensLeft), degraded: false };
  } catch (err) {
    redisHealthy = false;
    return { allowed: true, remaining: null, degraded: true };
  }
}

// --- RPC endpoint: the gateway calls this synchronously for every request ---
app.post("/check", async (req, res) => {
  const { key } = req.body || {};
  if (!key) {
    return res.status(400).json({ error: "missing 'key' in request body" });
  }

  const result = await checkRateLimit(key);
  const event = {
    type: "decision",
    node: NODE_ID,
    key,
    allowed: result.allowed,
    remaining: result.remaining,
    degraded: result.degraded,
    ts: new Date().toISOString(),
  };

  // Broadcast the decision (message-oriented / gossip-style communication)
  if (redisHealthy) {
    redisPub.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {});
  }
  broadcastToDashboards(event);

  res.status(200).json(result);
});

app.get("/health", (req, res) => {
  res.json({ node: NODE_ID, redisHealthy });
});

// --- Stream-oriented communication: push live events to dashboards ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });
const dashboardSockets = new Set();

wss.on("connection", (ws) => {
  dashboardSockets.add(ws);
  ws.send(JSON.stringify({ type: "hello", node: NODE_ID }));

  // --- WebRTC signaling relay ---
  // Dashboards send {type: "webrtc-signal", payload: <offer|answer|ice-candidate>}
  // over this SAME socket. We never inspect or store the payload — we just
  // forward it to the other connected dashboard(s) so two browsers can
  // negotiate a direct RTCPeerConnection with each other. This node is
  // "in the room" only for the handshake, not for the actual P2P data.
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.type === "webrtc-signal") {
      for (const peer of dashboardSockets) {
        if (peer !== ws && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({ type: "webrtc-signal", payload: msg.payload }));
        }
      }
    }
  });

  ws.on("close", () => dashboardSockets.delete(ws));
});

function broadcastToDashboards(event) {
  const payload = JSON.stringify(event);
  for (const ws of dashboardSockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Subscribe to peer nodes' broadcasts too, so this node's dashboard
// connections see decisions made by every node in the cluster.
// NOTE: subscribe() itself triggers ioredis's lazy connection, so this
// client is connected implicitly here rather than via an explicit
// .connect() call in start() (calling both would conflict).
const redisSub = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
redisSub.on("message", (_channel, message) => {
  try {
    const event = JSON.parse(message);
    if (event.node !== NODE_ID) broadcastToDashboards(event); // avoid double-send for own events
  } catch (_) {}
});

async function start() {
  try {
    await redis.connect();
    await redisPub.connect();
    await redisSub.subscribe(EVENTS_CHANNEL); // implicitly connects redisSub
    redisHealthy = true;
  } catch (err) {
    redisHealthy = false;
    console.warn(`[${NODE_ID}] could not connect to Redis at startup — starting in degraded (fail-open) mode: ${err.message}`);
  }

  server.listen(PORT, () => {
    console.log(`[${NODE_ID}] limiter-service listening on :${PORT} (redisHealthy=${redisHealthy})`);
  });
}

start();
