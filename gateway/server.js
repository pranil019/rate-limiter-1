/**
 * gateway/server.js
 *
 * The single entry point clients talk to. It is "transparent" middleware:
 * clients don't know how many limiter nodes exist or which one handled
 * their request (location transparency), and if one limiter node is down
 * the gateway retries another automatically (failure transparency).
 *
 * Demonstrates:
 *  - Middleware (Unit 1): gateway + limiter together form the middleware
 *    layer between clients and the backend service.
 *  - RPC (Unit 2): synchronous call to a limiter node's /check endpoint.
 *  - Design issue - scalability: LIMITER_NODES can be scaled out
 *    independently of the gateway; requests are load-balanced across them.
 *  - Design issue - fault tolerance: if the chosen limiter node doesn't
 *    respond, the gateway retries the next node before giving up.
 */

const express = require("express");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";
const LIMITER_NODES = (process.env.LIMITER_NODES || "http://localhost:4001,http://localhost:4002")
  .split(",")
  .map((s) => s.trim());

const RPC_TIMEOUT_MS = 800;

let rrIndex = 0; // round-robin pointer across limiter nodes

function nextNode() {
  const node = LIMITER_NODES[rrIndex % LIMITER_NODES.length];
  rrIndex += 1;
  return node;
}

async function callLimiterRPC(node, key) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${node}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`limiter responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tries every limiter node once (starting from the round-robin pick).
 * If ALL nodes are unreachable, fails open — same documented trade-off
 * as inside the limiter service itself.
 */
async function checkRateLimitWithFailover(key) {
  const start = rrIndex;
  for (let i = 0; i < LIMITER_NODES.length; i++) {
    const node = nextNode();
    try {
      const result = await callLimiterRPC(node, key);
      return { ...result, handledBy: node };
    } catch (err) {
      console.warn(`gateway: limiter node ${node} unreachable, trying next`);
    }
  }
  return { allowed: true, remaining: null, degraded: true, handledBy: "none-available" };
}

const app = express();
app.use(express.json());

app.use(async (req, res, next) => {
  // Rate-limit key: API key header if present, else client IP.
  const limitKey = req.header("x-api-key") || req.ip || "anonymous";

  const decision = await checkRateLimitWithFailover(limitKey);
  res.set("X-RateLimit-Remaining", decision.remaining == null ? "n/a" : String(Math.floor(decision.remaining)));
  res.set("X-RateLimit-Handled-By", decision.handledBy);
  if (decision.degraded) res.set("X-RateLimit-Degraded", "true");

  if (!decision.allowed) {
    return res.status(429).json({ error: "rate limit exceeded", key: limitKey });
  }
  next();
});

// Everything past the middleware is forwarded to the backend.
app.use(async (req, res) => {
  try {
    const backendRes = await fetch(`${BACKEND_URL}${req.originalUrl}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });
    const body = await backendRes.text();
    res.status(backendRes.status).send(body);
  } catch (err) {
    res.status(502).json({ error: "backend unreachable" });
  }
});

app.listen(PORT, () => {
  console.log(`gateway listening on :${PORT}, forwarding to ${BACKEND_URL}`);
  console.log(`limiter nodes: ${LIMITER_NODES.join(", ")}`);
});
