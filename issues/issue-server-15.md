# [MEDIUM] Error responses in attestation-registry-do leak internal error messages

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:93-98
**Type**: Security

**Description**: The catch-all error handler returns `error.message` directly to the client:
```js
} catch (error) {
  return new Response(
    JSON.stringify({ error: error.message }),
    { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```
The same pattern exists in `server-registry-do.js:54-58`.

Internal error messages from the JavaScript runtime, Durable Object storage layer, or crypto operations can contain stack traces, file paths, library versions, or other implementation details.

**Impact**: Information leakage that aids reconnaissance. An attacker learns about the server's internal architecture, library versions, and storage mechanisms from error messages. This information helps craft more targeted attacks.

**Fix**: Return a generic error message to the client and log the detailed error server-side:
```js
} catch (error) {
  console.error('Internal error:', error);
  return new Response(
    JSON.stringify({ error: 'Internal server error' }),
    { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```
