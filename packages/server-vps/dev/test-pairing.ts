/**
 * Test Pairing Flow
 *
 * Connects two WebSocket clients to different VPS servers in the local cluster
 * and tests the pairing flow. Run this while the cluster is running:
 *
 *   npx tsx dev/test-pairing.ts [server1-port] [server2-port]
 *   npm run dev:test-pairing
 */

import { WebSocket } from 'ws';

const SERVER1_PORT = parseInt(process.argv[2] || '9001', 10);
const SERVER2_PORT = parseInt(process.argv[3] || '9002', 10);

const PUBKEY_ALICE = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const PUBKEY_BOB = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';
const CODE_ALICE = 'ABC234';
const CODE_BOB = 'XYZ567';

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(ws: WebSocket, type: string, timeout = 10000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function connectWs(port: number): Promise<{ ws: WebSocket; serverInfo: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Connection timeout')); }, 5000);
    ws.on('open', () => {
      const handler = (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'server_info') {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve({ ws, serverInfo: msg });
        }
      };
      ws.on('message', handler);
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  console.log('=== Zajel Pairing Flow Test ===');
  console.log(`Alice connects to server on port ${SERVER1_PORT}`);
  console.log(`Bob connects to server on port ${SERVER2_PORT}`);
  console.log();

  // Connect Alice
  console.log('[Alice] Connecting...');
  const { ws: aliceWs, serverInfo: aliceInfo } = await connectWs(SERVER1_PORT);
  console.log(`[Alice] Connected to server ${(aliceInfo.serverId as string).substring(0, 20)}...`);

  // Connect Bob
  console.log('[Bob] Connecting...');
  const { ws: bobWs, serverInfo: bobInfo } = await connectWs(SERVER2_PORT);
  console.log(`[Bob] Connected to server ${(bobInfo.serverId as string).substring(0, 20)}...`);

  const sameServer = aliceInfo.serverId === bobInfo.serverId;
  console.log(`[Test] Same server: ${sameServer}`);
  console.log();

  // Register Alice
  console.log(`[Alice] Registering with code ${CODE_ALICE}...`);
  send(aliceWs, { type: 'register', pairingCode: CODE_ALICE, publicKey: PUBKEY_ALICE });
  const aliceReg = await waitForMessage(aliceWs, 'registered');
  console.log(`[Alice] Registered on server ${(aliceReg.serverId as string).substring(0, 20)}...`);

  // Register Bob
  console.log(`[Bob] Registering with code ${CODE_BOB}...`);
  send(bobWs, { type: 'register', pairingCode: CODE_BOB, publicKey: PUBKEY_BOB });
  const bobReg = await waitForMessage(bobWs, 'registered');
  console.log(`[Bob] Registered on server ${(bobReg.serverId as string).substring(0, 20)}...`);
  console.log();

  // Alice sends pair request to Bob
  console.log(`[Alice] Sending pair request to ${CODE_BOB}...`);
  send(aliceWs, { type: 'pair_request', targetCode: CODE_BOB });

  // Bob waits for pair_incoming
  console.log('[Bob] Waiting for pair_incoming...');
  try {
    const pairIncoming = await waitForMessage(bobWs, 'pair_incoming', 15000);
    console.log(`[Bob] Received pair_incoming from ${pairIncoming.fromCode}`);

    // Bob accepts
    console.log('[Bob] Accepting pair...');
    send(bobWs, { type: 'pair_response', targetCode: CODE_ALICE, accepted: true });

    // Both wait for pair_matched
    console.log('[Both] Waiting for pair_matched...');
    const [aliceMatched, bobMatched] = await Promise.all([
      waitForMessage(aliceWs, 'pair_matched', 10000),
      waitForMessage(bobWs, 'pair_matched', 10000),
    ]);

    console.log();
    console.log('=== PAIRING SUCCESSFUL ===');
    console.log(`  Alice: peerCode=${aliceMatched.peerCode}, isInitiator=${aliceMatched.isInitiator}`);
    console.log(`  Bob:   peerCode=${bobMatched.peerCode}, isInitiator=${bobMatched.isInitiator}`);

    // Test signaling relay
    console.log();
    console.log('[Alice] Sending offer to Bob...');
    send(aliceWs, {
      type: 'offer',
      target: CODE_BOB,
      payload: { sdp: 'v=0\r\ntest-offer' },
    });

    const offer = await waitForMessage(bobWs, 'offer', 5000);
    console.log(`[Bob] Received offer from ${offer.from}`);

    console.log('[Bob] Sending answer to Alice...');
    send(bobWs, {
      type: 'answer',
      target: CODE_ALICE,
      payload: { sdp: 'v=0\r\ntest-answer' },
    });

    const answer = await waitForMessage(aliceWs, 'answer', 5000);
    console.log(`[Alice] Received answer from ${answer.from}`);

    console.log();
    console.log('=== SIGNALING RELAY WORKS ===');
  } catch (err) {
    // Check if we got a rendezvous redirect instead (expected for cross-server pairing)
    console.log();
    console.log(`[Test] Cross-server pairing result: ${err}`);
    console.log('[Test] If pair_incoming timed out, this means the pairing code is on a');
    console.log('       different server and cross-server routing is needed (rendezvous).');
    console.log('[Test] Check server logs for rendezvous_partial messages.');

    // Check Alice for pair_error which would indicate the server tried to route
    try {
      const aliceResponse = await waitForMessage(aliceWs, 'pair_error', 2000);
      console.log(`[Alice] Got pair_error: ${JSON.stringify(aliceResponse)}`);
    } catch {
      console.log('[Alice] No pair_error received either.');
    }
  }

  aliceWs.close();
  bobWs.close();
  console.log();
  console.log('[Test] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
