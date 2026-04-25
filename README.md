# 🧠 MiniRAFT Drawing Board

A distributed real-time collaborative drawing application built using the **RAFT consensus algorithm**. This project demonstrates how multiple replicas maintain consistency and fault tolerance while synchronizing drawing data across clients.

---

## 🚀 Features

* 🎨 Real-time collaborative drawing
* 🔁 RAFT-based leader election and log replication
* ⚡ Fault tolerance (handles node failures)
* 🌐 WebSocket-based live updates
* 🐳 Dockerized multi-node setup
* 📡 Gateway-based request routing

---

## 🏗️ Architecture

```
Client → Gateway → Leader Replica → Followers
                          ↓
                    Log Replication
                          ↓
                    Commit (Majority)
                          ↓
                    Broadcast to Clients
```

### Components:

* **Frontend**: Drawing board UI (served via Nginx)
* **Gateway**: Routes requests and broadcasts updates
* **Replicas (3 nodes)**:

  * Participate in RAFT
  * Elect leader
  * Replicate logs
  * Maintain consistency

---

## 🧠 RAFT Concepts Used

* Leader Election
* Log Replication
* Majority Consensus
* Heartbeats
* Fault Tolerance

---

## ⚙️ Setup Instructions

### 1️⃣ Clone Repository

```bash
git clone https://github.com/ShagalVerma/MINI-RAFT-DRAWING-BOARD.git
```

---

### 2️⃣ Run with Docker

Make sure Docker Desktop is running.

```bash
docker compose up --build
```

---

### 3️⃣ Access Application

Open browser:

```
http://localhost:3000
```

---

## 🧪 How to Test

### ✔️ Normal Operation

* Open multiple browser tabs
* Draw in one tab → updates reflect in others

---

### ✔️ Leader Failure

```bash
docker stop replica1
```

* System elects new leader
* Drawing continues after short delay

---

### ✔️ Follower Failure

```bash
docker stop replica2
```

* System continues normally (majority still available)

---

## ⚠️ Known Behavior

* Small delay during leader failure (expected in distributed systems)
* Updates appear only after log is committed (strong consistency)

---

## 🧠 Design Decisions

* Only **leader broadcasts updates** (standard RAFT)
* Followers replicate logs but do not directly communicate with clients
* Gateway handles WebSocket communication and client synchronization

---

## 🔧 Tech Stack

* **Node.js (Express)**
* **WebSockets**
* **Docker**
* **RAFT Algorithm (custom implementation)**
* **Nginx (frontend hosting)**

---

## 📂 Project Structure

```
frontend/     → UI (HTML, JS)
gateway/      → WebSocket + routing
replica1/     → RAFT node
replica2/     → RAFT node
replica3/     → RAFT node
docker-compose.yml
```

---

## 🎯 Key Learning Outcomes

* Understanding distributed consensus (RAFT)
* Handling leader election and failover
* Managing state consistency across nodes
* Designing fault-tolerant systems

---

## 📌 Conclusion

This project demonstrates a simplified but practical implementation of the RAFT consensus algorithm for real-time applications. It highlights trade-offs between consistency, availability, and performance in distributed systems.

---

## 🙌 Acknowledgement

Inspired by distributed systems concepts and RAFT protocol design.

---
