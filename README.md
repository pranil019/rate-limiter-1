# Distributed Rate Limiting Service — FA-1

A distributed rate limiting service for scalable API infrastructure, built to
demonstrate concepts from **Unit 1: Introduction to Distributed Systems** and
**Unit 2: Communication**.

## Architecture

```
                 ┌─────────────┐
  clients ─────► │   Gateway   │  (middleware — transparent to clients)
                 └──────┬──────┘
                        │ RPC (HTTP POST /check)
              ┌─────────┴─────────┐
              ▼                   ▼
       ┌────────────┐      ┌────────────┐
       │ Limiter-1  │◄────►│ Limiter-2  │   pub/sub gossip over Redis
       └─────┬──────┘      └─────┬──────┘   (message-oriented, P2P-style)
             │                    │
             └─────────┬──────────┘
                        ▼
                    ┌───────┐
                    │ Redis │  shared token-bucket state
                    └───────┘

              limiter nodes also stream events over
              WebSocket ───────► Dashboard (stream-oriented)

  gateway ──────────────────────────────► Backend (mock API)
       (only forwarded if the limiter allowed the request)
```

## Components

| Component | Role |
|---|---|
| `gateway/` | Single entry point for clients. Middleware: intercepts every request, calls the limiter via RPC, forwards or rejects. |
| `limiter-service/` | The distributed rate limiter itself. Each instance is a peer node; Redis holds shared token-bucket state. |
| `backend-mock/` | Stand-in "real" API the system protects. Has no awareness that rate limiting exists. |
| `dashboard/` | Static HTML page that opens a WebSocket to a limiter node and shows a live feed of allow/deny decisions across the whole cluster. |
| `docker-compose.yml` | Runs Redis + 2 limiter nodes + gateway + backend together to demonstrate a real multi-node deployment. |

## Syllabus mapping

### Unit 1 — Introduction to Distributed Systems

- **Definition & Goals** — the system provides *resource sharing* (protecting
  one backend from being overwhelmed by many clients) and aims for
  *scalability* (add more limiter nodes as traffic grows) and *transparency*
  (clients never know which limiter node or how many exist).
- **Types of Distributed Systems** — this project is actually a mix of two
  types, at two different layers:
  - *Client-server*: clients → gateway → backend is a classic client-server
    chain, and the gateway → limiter RPC call is also client-server (the
    gateway is a client of the limiter).
  - *Peer-to-peer / cluster computing*: the limiter nodes themselves have no
    central coordinator or leader — each one talks to the others as an
    equal, gossiping its decisions over Redis pub/sub. Losing any one
    limiter node doesn't take down the "cluster", which is the defining
    trait of a P2P/cluster-style system rather than a strict client-server
    one.
- **Architectures** — layered client → gateway → limiter → backend
  architecture, with the limiter tier itself organized as a set of
  cooperating peers rather than one central authority.
- **Design Issues**
  - *Scalability*: limiter nodes are stateless compute in front of shared
    Redis state, so horizontal scaling just means adding nodes.
  - *Consistency vs. availability*: under a Redis outage, the system
    intentionally **fails open** (see `checkRateLimit` in
    `limiter-service/server.js` and `checkRateLimitWithFailover` in
    `gateway/server.js`) — availability is prioritized over strict limit
    accuracy, a classic CAP-style trade-off.
  - *Fault tolerance*: the gateway retries a different limiter node if one
    is unreachable before giving up.
- **Middleware** — the gateway + limiter tier together are the middleware:
  they add a cross-cutting policy (rate limiting) without the backend or
  the client needing to implement or know about it.
- **Role of Virtualization** — `docker-compose.yml` runs every component
  (both limiter nodes, the gateway, the backend, Redis) as its own isolated
  container, each with its own filesystem and process space, all on one
  physical/virtual machine. This is what lets the "distributed" system be
  demonstrated on a single laptop: virtualization is what makes 5
  independent-looking nodes possible without needing 5 separate computers.
  Scaling out for real just means running the same container image on more
  physical machines — the code doesn't change, only where the containers
  are placed.

### Unit 2 — Communication

- **Fundamentals of Communication** — a mix of synchronous (RPC) and
  asynchronous (pub/sub, streaming) communication is used deliberately for
  different purposes.
- **Names, Identifiers & Addresses** — the system uses several distinct
  naming schemes, each solving a different problem:
  - *Names* — each limiter node has a human-readable `NODE_ID` (`limiter-1`,
    `limiter-2`) used in logs and in the dashboard so a person can tell
    nodes apart.
  - *Identifiers* — the rate-limit `key` (an API key or client IP) uniquely
    identifies *whose* bucket a request should be checked against — this is
    an identifier, not a location, so it stays valid no matter which
    limiter node happens to handle the request.
  - *Addresses* — `LIMITER_NODES` in the gateway holds the actual
    `host:port` addresses used to physically reach each node over the
    network. Note the separation: the gateway routes by *address*, but the
    business logic (the token bucket) is keyed by *identifier* — if a node's
    address changed (e.g. it moved to a new machine), the buckets
    themselves would be unaffected since Redis keys them by identifier, not
    by which node touched them last.
- **RPC** — `gateway → limiter POST /check` is a synchronous
  request/response call: the gateway blocks briefly for an allow/deny
  answer before proceeding.
- **Message-Oriented Communication** — limiter nodes publish every decision
  to a shared Redis pub/sub channel (`rl:events`) rather than calling each
  other directly; this is asynchronous, decoupled communication.
- **Stream-Oriented Communication** — the `/stream` WebSocket endpoint
  pushes a continuous, ordered stream of events to the dashboard, distinct
  from the request/response RPC calls.
- **P2P Messaging** — limiter nodes have no central coordinator; each
  publishes and subscribes to the same channel, and the cluster's state is
  the emergent result of all nodes gossiping their local decisions.
- **WebRTC** — the dashboard includes a real WebRTC data channel: open
  `dashboard/index.html` in two browser windows, click **"Connect (Peer A)"**
  in one of them, and the two browsers negotiate a direct
  `RTCPeerConnection` with each other. A limiter node's existing WebSocket
  is reused *only* as the signaling relay (see `webrtc-signal` handling in
  `limiter-service/server.js`) to exchange the SDP offer/answer and ICE
  candidates — the server never sees the actual notes typed once the
  "Peer Notes" panel shows **connected**. This is deliberately kept honest:
  WebRTC's whole point is direct browser-to-browser data, so the demo
  feature (typed notes shared instantly between two dashboards) is the
  smallest thing that actually needs that property, rather than forcing
  WebRTC into the core allow/deny path where a plain WebSocket already
  does the right job.

## Running it

```bash
docker compose up --build
```

Then:

```bash
# Send requests through the gateway
curl http://localhost:3000/api/data -H "x-api-key: demo-user"

# Open the dashboard
open dashboard/index.html   # or just double-click it
```

Send several requests quickly (e.g. `for i in {1..15}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/data -H "x-api-key: demo-user"; done`)
and watch the dashboard show ALLOW responses turn into DENY (429) once the
token bucket for `demo-user` is empty, then slowly refill.

## Trying the WebRTC peer notes feature

1. Make sure at least `limiter-1` and `redis` are running (the dashboard
   connects to `ws://localhost:4001/stream` for both live events and
   WebRTC signaling).
2. Open `dashboard/index.html` in two separate browser windows, side by
   side.
3. In window #1, click **"Connect (Peer A)"**. Window #2 doesn't need any
   click — it auto-responds to the incoming offer.
4. Once both show **"peer: connected (direct P2P data channel)"**, type in
   either window's note box and press Enter — the note appears instantly
   in the other window, sent directly between the two browsers.
