# Plan: Error responses in attestation-registry-do leak internal error messages

**Issue**: issue-server-15.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`:
- Lines 93-98: The catch-all error handler returns `error.message` directly to the client:
  ```js
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  ```

In `packages/server/src/durable-objects/server-registry-do.js`:
- Lines 54-58: The same pattern:
  ```js
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  ```

Internal error messages from the Cloudflare Workers runtime, Durable Object storage API, or crypto operations can contain implementation details like stack traces, file paths, class names, and library version numbers.

## Fix Steps

1. **Update `attestation-registry-do.js` catch block** (lines 93-98):
   ```js
   } catch (error) {
     console.error('AttestationRegistry error:', error.message, error.stack);
     return new Response(
       JSON.stringify({ error: 'Internal server error' }),
       { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
     );
   }
   ```

2. **Update `server-registry-do.js` catch block** (lines 54-58):
   ```js
   } catch (error) {
     console.error('ServerRegistry error:', error.message, error.stack);
     return new Response(
       JSON.stringify({ error: 'Internal server error' }),
       { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
     );
   }
   ```

3. **Review other error responses** for information leakage:
   - `websocket-handler.js` line 58: `this.sendError(ws, 'Invalid message format: JSON parse error')` -- this is acceptable (tells the client the format is wrong without leaking internals).
   - `relay-registry-do.js` line 110: `this.handler.sendError(ws, 'Internal server error')` -- already generic.
   - `signaling-room.js` line 40: `this.sendError(ws, 'Invalid message format')` -- already generic.
   - `signaling-room.js` line 79: `this.sendError(ws, 'Unknown message type: ${type}')` -- echoes user input. Consider sanitizing or removing the type from the response.

4. **Sanitize the unknown message type error** in `signaling-room.js` line 79:
   ```js
   this.sendError(ws, 'Unknown message type');
   ```
   Similarly in `websocket-handler.js` line 102:
   ```js
   this.sendError(ws, 'Unknown message type');
   ```

## Testing

- Trigger a 500 error (e.g., by causing a storage failure) and verify the response contains "Internal server error" not the actual error details.
- Verify that `console.error` is called with the actual error details for debugging.
- Verify that legitimate error responses (400, 401, 404) still contain their specific messages.

## Risk Assessment

- **Debugging difficulty**: Generic error messages make it harder to debug issues from client-side logs. Ensure server-side logging (`console.error`) captures enough detail. Cloudflare Workers logs are available via `wrangler tail`.
- **Very low risk**: This change only affects the error response body, not the control flow. All error handling logic remains the same.
