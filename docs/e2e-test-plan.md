# Zajel E2E Test Plan

## Overview

This document outlines end-to-end test scenarios covering the complete flow from Flutter apps through the bootstrap service to VPS servers.

## Architecture Under Test

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Flutter App │────►│  CF Workers      │◄────│ VPS Server  │
│  (Client)   │     │  (Bootstrap)     │     │ (Signaling) │
└─────────────┘     └──────────────────┘     └─────────────┘
       │                                            │
       └────────────────────────────────────────────┘
                    Direct Connection
```

---

## Test Categories

### 1. Bootstrap Service Tests (CF Workers)

#### 1.1 Health Check
- **Endpoint:** `GET /health`
- **Expected:** `{"status":"ok","service":"zajel-bootstrap",...}`
- **Test:**
  ```bash
  curl https://signal.zajel.hamzalabs.dev/health
  ```

#### 1.2 Server Registration
- **Endpoint:** `POST /servers`
- **Payload:**
  ```json
  {
    "serverId": "ed25519:test123",
    "endpoint": "wss://test.example.com",
    "publicKey": "base64key",
    "region": "eu-west"
  }
  ```
- **Expected:** `{"success":true,"server":{...}}`

#### 1.3 Server List
- **Endpoint:** `GET /servers`
- **Expected:** `{"servers":[...]}`
- **Verify:** Only servers with lastSeen < 5 minutes are returned

#### 1.4 Server Heartbeat
- **Endpoint:** `POST /servers/heartbeat`
- **Payload:** `{"serverId":"ed25519:test123"}`
- **Expected:** `{"success":true,"peers":[...]}`
- **Verify:** Returns other registered servers (not self)

#### 1.5 Server Unregistration
- **Endpoint:** `DELETE /servers/:serverId`
- **Expected:** `{"success":true}`
- **Verify:** Server no longer appears in list

#### 1.6 Stale Server Cleanup
- **Test:** Register server, wait 5+ minutes without heartbeat
- **Expected:** Server automatically removed from list

---

### 2. VPS Server Tests

#### 2.1 Server Startup & Registration
- **Test:** Start VPS server, check CF Workers
- **Verify:**
  - Server registers with CF on startup
  - Server appears in `GET /servers` list
  - Server ID matches expected format `ed25519:<base64>`

#### 2.2 Heartbeat Loop
- **Test:** Monitor VPS server for 2+ minutes
- **Verify:**
  - Heartbeats sent every 60 seconds
  - Server remains in CF registry
  - Peer list is received and processed

#### 2.3 Graceful Shutdown
- **Test:** Stop VPS server gracefully (SIGTERM)
- **Verify:**
  - Server unregisters from CF
  - Server no longer in `GET /servers` list

#### 2.4 Health Endpoint
- **Endpoint:** `GET http://<vps-ip>:9000/health`
- **Expected:** `{"status":"healthy","serverId":"...","uptime":...}`

#### 2.5 Stats Endpoint
- **Endpoint:** `GET http://<vps-ip>:9000/stats`
- **Expected:** Server info including region, nodeId, endpoint

---

### 3. Flutter App Tests

#### 3.1 Server Discovery
- **Test:** Open app, enable external connections
- **Verify:**
  - App fetches servers from CF Workers
  - App selects a VPS server
  - Selected server shown in settings

#### 3.2 Connection to VPS Server
- **Test:** Enable external connections
- **Verify:**
  - WebSocket connects to selected VPS
  - Pairing code is generated
  - Connection state shows "connected"

#### 3.3 Server Failover
- **Test:**
  1. Connect to VPS server A
  2. Simulate VPS server A going offline
  3. Disable/re-enable external connections
- **Verify:** App connects to different VPS server

#### 3.4 Bootstrap URL Configuration
- **Test:** Change bootstrap URL in settings
- **Verify:**
  - New URL is saved
  - Discovery uses new URL
  - Reset button restores default

#### 3.5 No Servers Available
- **Test:** Configure invalid bootstrap URL
- **Verify:**
  - Appropriate error message shown
  - App remains functional for local connections

---

### 4. End-to-End Connection Tests

#### 4.1 Two Devices Same VPS
- **Setup:** Two Flutter apps, both connect to same VPS
- **Test:**
  1. Device A enables external connections, gets code ABC123
  2. Device B scans/enters code ABC123
  3. WebRTC connection established
  4. Send message from A to B
  5. Send message from B to A
- **Verify:**
  - Messages delivered both directions
  - Encryption working (messages not in plain text on server)

#### 4.2 Two Devices Different VPS (Federation)
- **Setup:** Two VPS servers federated, two Flutter apps
- **Test:**
  1. Device A connects to VPS-1
  2. Device B connects to VPS-2
  3. Exchange pairing codes
  4. Establish connection
- **Verify:**
  - Cross-VPS signaling works
  - Messages delivered through relay if needed

#### 4.3 QR Code Pairing
- **Test:**
  1. Device A shows QR code
  2. Device B scans QR code
  3. Connection established
- **Verify:**
  - QR code contains valid `zajel://` URI
  - Auto-connect on scan
  - Success notification shown

#### 4.4 Manual Code Entry
- **Test:**
  1. Device A shows code
  2. Device B manually enters code
  3. Connection established
- **Verify:**
  - 6-character alphanumeric code
  - Case-insensitive entry
  - Connection succeeds

---

### 5. Relay & Rendezvous Tests

#### 5.1 Meeting Point Registration
- **Test:** Two trusted peers both online
- **Verify:**
  - Both register at meeting points
  - Live match detected
  - Connection re-established

#### 5.2 Dead Drop Delivery
- **Test:**
  1. Peer A online, Peer B offline
  2. Peer A leaves encrypted dead drop
  3. Peer B comes online
- **Verify:**
  - Dead drop retrieved
  - Connection info decrypted
  - Connection established

#### 5.3 Relay Load Balancing
- **Test:** Multiple peers acting as relays
- **Verify:**
  - Load reported to server
  - New connections distributed across relays

---

### 6. Error Handling Tests

#### 6.1 Network Interruption
- **Test:** Disconnect network during active connection
- **Verify:**
  - Graceful disconnection
  - Reconnection attempted when network restored
  - No crash or data loss

#### 6.2 Server Unavailable
- **Test:** VPS server crashes during connection
- **Verify:**
  - Client detects disconnection
  - Error message shown
  - Can reconnect to different server

#### 6.3 Invalid Pairing Code
- **Test:** Enter non-existent pairing code
- **Verify:**
  - Appropriate error message
  - No crash
  - Can retry

#### 6.4 Concurrent Connections
- **Test:** Try to connect to same peer multiple times
- **Verify:**
  - Duplicate connections prevented or handled
  - No resource leaks

---

### 7. Performance Tests

#### 7.1 Server Discovery Latency
- **Metric:** Time from app start to server list
- **Target:** < 2 seconds

#### 7.2 Connection Establishment Time
- **Metric:** Time from code entry to connected state
- **Target:** < 5 seconds on good network

#### 7.3 Message Latency
- **Metric:** Round-trip time for message
- **Target:** < 500ms for text messages

#### 7.4 Bootstrap Server Load
- **Test:** Simulate 100 VPS servers registering
- **Verify:**
  - All registrations succeed
  - List endpoint responds < 1 second

---

## Test Execution Checklist

### Pre-requisites
- [ ] CF Workers deployed (v1.1.0+)
- [ ] VPS Server deployed (v1.1.0+)
- [ ] Flutter app built (v1.1.0+)
- [ ] Two test devices available
- [ ] Network access to all services

### Manual Test Run
```
Date: ___________
Tester: ___________

Bootstrap Service:
[ ] 1.1 Health Check
[ ] 1.2 Server Registration
[ ] 1.3 Server List
[ ] 1.4 Server Heartbeat
[ ] 1.5 Server Unregistration

VPS Server:
[ ] 2.1 Startup & Registration
[ ] 2.2 Heartbeat Loop
[ ] 2.4 Health Endpoint

Flutter App:
[ ] 3.1 Server Discovery
[ ] 3.2 Connection to VPS
[ ] 3.4 Bootstrap URL Config

E2E Connection:
[ ] 4.1 Two Devices Same VPS
[ ] 4.3 QR Code Pairing
[ ] 4.4 Manual Code Entry

Error Handling:
[ ] 6.3 Invalid Pairing Code
```

---

## Automated Test Implementation

### Location
```
packages/
├── server/
│   └── tests/
│       └── e2e/
│           ├── bootstrap.test.js
│           └── integration.test.js
├── server-vps/
│   └── tests/
│       └── e2e/
│           ├── bootstrap-client.test.ts
│           └── federation.test.ts
└── app/
    └── test/
        └── e2e/
            ├── server_discovery_test.dart
            └── connection_test.dart
```

### Framework Recommendations
- **CF Workers:** Vitest with Miniflare
- **VPS Server:** Vitest with actual server instances
- **Flutter App:** Integration tests with flutter_test

---

## Success Criteria

1. **Bootstrap:** All CF Workers endpoints respond correctly
2. **VPS:** Server registers, heartbeats, and unregisters cleanly
3. **App:** Can discover servers and connect automatically
4. **E2E:** Two devices can connect and exchange messages
5. **Resilience:** Graceful handling of network issues and server failures
