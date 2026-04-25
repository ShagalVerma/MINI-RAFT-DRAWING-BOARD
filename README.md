# MiniRAFT Drawing Board

A real-time, fault-tolerant collaborative whiteboard built on a hand-rolled implementation of the RAFT consensus protocol.

Multiple users draw simultaneously in their browsers; every stroke is sent to a stateless gateway, which forwards it to the elected leader of a 4-node RAFT cluster. The leader replicates the stroke to a majority of followers before committing it, then the gateway broadcasts the committed stroke to every connected client. The result: every browser sees the exact same canvas, even under leader failures and network partitions.

**GitHub:** https://github.com/ShagalVerma/MINI-RAFT-DRAWING-BOARD

---

## Architecture

```
                 ┌──────────────┐
   browsers ───▶ │   gateway    │ ───▶ leader replica ──▶ followers (majority)
   (WebSocket)   │ (WS + HTTP)  │                              │
                 └──────────────┘                              │
                        ▲                                      │
                        └────── committed strokes ─────────────┘
```

### Components

| Service     | Port(s)         | Role                                                                   |
| ----------- | --------------- | ---------------------------------------------------------------------- |
| `frontend`  | `3000`          | Static nginx serving the canvas + dashboard UI.                        |
| `gateway`   | `8080`, `8081`  | WebSocket fan-out + HTTP control plane; routes writes to leader.       |
| `replica1`  | `4001`          | RAFT replica.                                                          |
| `replica2`  | `4002`          | RAFT replica.                                                          |
| `replica3`  | `4003`          | RAFT replica.                                                          |
| `replica4`  | `4004`          | RAFT replica (bonus 4th node — cluster size 4, majority = 3).          |

All services run on a shared Docker bridge network (`raft-net`).

---

## Quick Start

```bash
docker compose up --build
```

Then open:

- **Drawing board:** http://localhost:3000
- **Cluster dashboard:** http://localhost:3000/dashboard.html *(if separated)* or scroll down on the main page.

To watch leader election in real time, open the dashboard in one tab and the canvas in another — the dashboard polls each replica every 1.5 s and updates its leader/term/log-size strip live.

---

## RAFT Implementation

Each replica implements the core RAFT protocol from scratch:

- **Leader election** with randomized 150–300 ms election timeouts.
- **`requestVote` / `appendEntries`** RPCs over plain HTTP (Express).
- **Heartbeats** every 50 ms from the leader to suppress new elections.
- **Log replication** with majority-quorum commit; followers only commit entries the leader marks as committed.
- **Catch-up sync** via a `/sync-log` endpoint when a follower's log lags or diverges.
- **Term-based safety** — any RPC with a higher term immediately demotes the receiver to follower.

`CLUSTER_SIZE` and `MAJORITY` are derived dynamically from the `PEERS` environment variable, so adding or removing replicas in `docker-compose.yml` requires zero code changes.

---

## Bonus Features

### 1. Network partition simulation

Each replica maintains a `blockedPeers` set. Outgoing RPCs to blocked peers short-circuit; incoming RPCs from blocked senders are rejected with HTTP 503. Control endpoints:

```
GET  /admin/partition           — view current block list
POST /admin/partition           — { block: [...], unblock: [...], reset: bool }
POST /admin/heal                — clear all blocks
```

The dashboard exposes **Isolate** and **Heal** buttons per node that wire up symmetric partitions across the whole cluster — no `docker stop` needed. A minority partition keeps trying to elect leaders forever and never succeeds, demonstrating RAFT's split-brain safety.

### 2. 4-node cluster

A 4th replica was added (`replica4/`) without touching the core RAFT logic — `CLUSTER_SIZE` and `MAJORITY` adapt automatically. The dashboard renders a card per replica from a `GET /replicas` endpoint, so adding a 5th node would just mean adding to `docker-compose.yml`.

### 3. Vector-based Undo / Redo via log compensation

Every stroke segment carries a `strokeId` (group identity) and `clientId` (originator). Undo and redo are **first-class log entries** that flow through RAFT just like strokes — when you press Ctrl+Z, your client emits an `{ type: 'undo', strokeId }` event that the leader replicates to a majority before broadcasting it back. Every client (including late-joiners replaying the full canvas log) ends up with the same set of visible strokes.

| Stack         | Contains                                | Pushed when     | Popped when |
| ------------- | --------------------------------------- | --------------- | ----------- |
| `myUndoStack` | strokes I drew, currently visible       | I draw a stroke | I undo      |
| `myRedoStack` | strokes I undid, currently hidden       | I undo          | I redo      |

Drawing a new stroke clears the redo stack (matches Figma / VS Code semantics).

### 4. Live cluster dashboard

A summary strip + per-replica cards show:

- 👑 Current leader name
- 📐 Cluster size + 🎯 majority required
- 👥 Connected client count
- ⏳ Pending strokes in the gateway queue
- Per-replica term, role, log size, commit index, peer reachability, and a `PARTITIONED` badge when block lists are active.

Cards are rendered dynamically from the gateway's `GET /replicas`, so the dashboard scales with the cluster size automatically.

---

## File Layout

```
MiniRAFT/
├── docker-compose.yml          # 6 services on a shared bridge network
├── frontend/
│   └── index.html              # Canvas + dashboard, all in one page
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── src/index.js            # WebSocket server, leader-tracking, log replay
├── replica1/                   # All four replicas are byte-identical;
├── replica2/                   # behavior is parameterized by env vars.
├── replica3/
└── replica4/
    ├── Dockerfile
    ├── package.json
    └── src/index.js            # RAFT state machine + canvas log
```

---

## Useful Endpoints

### Per replica (`http://localhost:4001` … `4004`)

| Method | Path                | Purpose                                          |
| ------ | ------------------- | ------------------------------------------------ |
| GET    | `/status`           | Term, role, leader, log size, peer reachability. |
| POST   | `/request-vote`     | RAFT vote RPC.                                   |
| POST   | `/append-entries`   | RAFT log replication / heartbeat RPC.            |
| POST   | `/sync-log`         | Follower catch-up.                               |
| GET    | `/admin/partition`  | View block list.                                 |
| POST   | `/admin/partition`  | Mutate block list.                               |
| POST   | `/admin/heal`       | Clear all blocks.                                |

### Gateway (`http://localhost:8081`)

| Method | Path          | Purpose                                            |
| ------ | ------------- | -------------------------------------------------- |
| GET    | `/health`     | Gateway liveness + cached leader info.             |
| GET    | `/replicas`   | Cluster topology for the dashboard.                |
| GET    | `/cluster`    | Aggregated `/status` snapshot of every replica.    |
| WS     | `:8080`       | Bidirectional stroke / undo / redo / clear stream. |

---

## Demo Script

Try this once everything is running:

1. Open `http://localhost:3000` in two browser tabs and draw — strokes appear in both tabs in real time.
2. Open the dashboard. Click **Isolate** on the current leader's card. Watch a new leader get elected within ~300 ms; the canvas keeps working.
3. Click **Heal**. The deposed leader rejoins as a follower and catches up via `/sync-log`.
4. Press **Ctrl+Z** in one tab. The stroke disappears in *both* tabs (undo replicates through RAFT).
5. Isolate **two** replicas at once — the cluster loses quorum and writes block. Heal one — quorum returns and pending strokes commit.

---

## Requirements

- Docker 24+ with Compose v2.
- A modern browser (Chrome, Firefox, Safari).

No host-side Node install needed — every service runs inside its container.

---

## License

MIT.
