# Issue #41: Pairing Code Entropy Monitoring Research

## Executive Summary

This document analyzes the current entropy monitoring implementation for pairing codes in the Zajel signaling system, provides additional research on industry comparisons (Google Meet, AirDrop), and recommends monitoring dashboard configurations and alert thresholds.

## Current Implementation Analysis

### Location and Architecture

The entropy monitoring is implemented across three files:

1. **`/home/meywd/zajel/packages/server-vps/src/client/handler.ts`**
   - `EntropyMetrics` interface (lines 129-136)
   - `entropyMetrics` private field (lines 188-192)
   - `getEntropyMetrics()` method (lines 1174-1193)
   - Collision detection in `handlePairingCodeRegister()` (lines 556-591)

2. **`/home/meywd/zajel/packages/server-vps/src/index.ts`**
   - `/metrics` HTTP endpoint (lines 96-118)

3. **`/home/meywd/zajel/packages/server-vps/src/constants.ts`**
   - `ENTROPY` constant thresholds (lines 57-66)

### Metrics Currently Tracked

```typescript
interface EntropyMetrics {
  activeCodes: number;           // Current active pairing codes
  peakActiveCodes: number;       // High-water mark
  totalRegistrations: number;    // Lifetime registrations
  collisionAttempts: number;     // Collision count
  collisionRisk: 'low' | 'medium' | 'high';
}
```

### Threshold Configuration

```typescript
export const ENTROPY = {
  COLLISION_LOW_THRESHOLD: 10000,    // Low risk
  COLLISION_MEDIUM_THRESHOLD: 20000, // Medium risk
  COLLISION_HIGH_THRESHOLD: 30000,   // High risk - consider extending code length
} as const;
```

### Collision Detection Logic

When a client registers with a pairing code that already exists:

```typescript
if (this.pairingCodeToWs.has(pairingCode)) {
  this.entropyMetrics.collisionAttempts++;
  logger.warn(`Pairing code collision detected: ${pairingCode} (total collisions: ${this.entropyMetrics.collisionAttempts})`);

  this.send(ws, {
    type: 'code_collision',
    message: 'Pairing code already in use. Please reconnect with a new code.',
  });
  return;
}
```

### HTTP Metrics Endpoint

`GET /metrics` returns:

```json
{
  "serverId": "abc123",
  "uptime": 3600.5,
  "connections": {
    "relay": 50,
    "signaling": 100
  },
  "pairingCodeEntropy": {
    "activeCodes": 100,
    "peakActiveCodes": 250,
    "totalRegistrations": 1500,
    "collisionAttempts": 0,
    "collisionRisk": "low"
  }
}
```

---

## Collision Probability Mathematics

### Birthday Paradox Formula

The probability of at least one collision among `n` codes from a space of `N` possible codes:

```
P(collision) = 1 - e^(-n^2 / (2 * N))
```

### Zajel Parameters

- **Alphabet size**: 32 characters (A-Z excluding I,O plus 2-9)
- **Code length**: 6 characters
- **Total space (N)**: 32^6 = 1,073,741,824 (~1.07 billion)
- **Entropy**: 30 bits

### Collision Probability Table

| Active Codes (n) | Collision Probability | Expected Collisions | Risk Level |
|------------------|----------------------|---------------------|------------|
| 1,000 | 0.000047% | ~0.00047 | Negligible |
| 5,000 | 0.0012% | ~0.012 | Very Low |
| 10,000 | 0.0047% | ~0.047 | Low |
| 20,000 | 0.019% | ~0.19 | Low-Medium |
| 30,000 | 0.042% | ~0.42 | Medium |
| 33,000 | 0.051% | ~0.51 | Birthday Threshold |
| 38,600 | 0.069% | ~0.69 | 50% Point |
| 50,000 | 0.116% | ~1.16 | Medium-High |
| 100,000 | 0.46% | ~4.6 | High |

### 50% Collision Point (Birthday Bound)

```
n_50 = sqrt(2 * N * ln(2)) = sqrt(1.386 * 1,073,741,824) = ~38,581 codes
```

At approximately 38,600 concurrent active codes, there is a 50% probability of at least one collision.

---

## Industry Comparison Research

### Google Meet Room Codes

**Format**: 10 alphanumeric characters from a 25-character set

**Example**: `abc-defg-hij`

**Entropy Calculation**:
- Character space: 25 characters
- Code length: 10 characters (excluding hyphens)
- Total combinations: 25^10 = 9.5 x 10^13
- **Bits of entropy**: log2(25^10) = ~46.4 bits

**Security Measures** (based on [Google Meet Security documentation](https://support.google.com/meet/answer/9852160?hl=en)):
1. The 10-character format makes brute-force guessing "harder"
2. Rate limiting on join attempts
3. Machine learning for usage anomaly detection
4. Meetings require authentication for domain-level meetings
5. Waiting rooms and host controls for participants

**Collision Prevention**:
- Google uses server-side uniqueness checking
- Meeting IDs are generated server-side, not client-side
- The significantly higher entropy (46 bits vs 30 bits) provides ~65,000x larger code space

**Relevance to Zajel**: Google Meet's server-side generation eliminates client-side collisions entirely. Zajel generates codes client-side but detects collisions server-side.

### AirDrop Device Discovery

**Architecture** (based on [Apple AirDrop Security](https://support.apple.com/guide/security/airdrop-security-sec2261183f4/web)):

AirDrop uses a fundamentally different approach - no shared codes:

1. **BLE Advertisement**: Devices broadcast a "short identity hash" derived from email/phone numbers
2. **Identity Hash**: Created from contact identifiers on Apple ID
3. **Authentication**: 2048-bit RSA identity stored on device
4. **Key Exchange**: Mutual TLS authentication before transfer

**Known Vulnerabilities** (2021 TU Darmstadt research via [PrivateDrop paper](https://www.usenix.org/system/files/sec21fall-heinrich.pdf)):
- Identity hashes can be reversed via brute-force/dictionary attacks
- Contact identifiers (phone numbers) are easily enumerable

**2025 Updates** (based on search results):
- iOS 26.2 introduces PIN pairing codes for AirDrop
- New "shareable codes" feature with time-limited access
- Ongoing privacy improvements ("AirDropPrivacyImprovements")

**Relevance to Zajel**:
- AirDrop's hash-based discovery has different collision semantics
- The new PIN pairing feature shows industry trend toward code-based verification
- AirDrop relies on proximity (BLE range) rather than entropy for security

### Comparative Summary

| Platform | Code Format | Entropy (bits) | Generation | Collision Handling |
|----------|-------------|----------------|------------|-------------------|
| **Zajel** | 6 chars (32 set) | 30 | Client-side | Server detection, client regeneration |
| **Zoom** | 9-11 digits | 30-37 | Server-side | Server uniqueness check |
| **Google Meet** | 10 chars (25 set) | 46 | Server-side | Server uniqueness check |
| **WhatsApp** | 8 digits | 26 | Server-side | User confirmation required |
| **Discord** | 7-8 chars (62 set) | 42 | Server-side | Server uniqueness check |
| **AirDrop** | Hash-based | N/A | Device-derived | Proximity limitation |

---

## Recommended Alert Thresholds

### Prometheus/Grafana Alert Configuration

Based on the birthday paradox analysis and current thresholds:

```yaml
# Prometheus AlertManager rules
groups:
  - name: pairing-code-entropy
    rules:
      # Warning: Approaching medium risk
      - alert: PairingCodeEntropyMedium
        expr: zajel_active_pairing_codes >= 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pairing code entropy reaching medium risk"
          description: "{{ $value }} active pairing codes. Monitor for collisions."

      # Critical: High collision risk
      - alert: PairingCodeEntropyHigh
        expr: zajel_active_pairing_codes >= 30000
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Pairing code entropy at HIGH risk"
          description: "{{ $value }} active codes. Consider extending code length to 8 characters."

      # Collision rate spike
      - alert: PairingCodeCollisionSpike
        expr: rate(zajel_collision_attempts[5m]) > 0.1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Pairing code collision rate increasing"
          description: "{{ $value }} collisions/sec. Investigate potential issues."

      # Any collision (for tracking)
      - alert: PairingCodeCollisionDetected
        expr: increase(zajel_collision_attempts[1h]) > 0
        labels:
          severity: info
        annotations:
          summary: "Pairing code collision detected"
          description: "{{ $value }} collision(s) in the last hour."

      # Peak capacity warning
      - alert: PairingCodePeakApproachingLimit
        expr: zajel_peak_active_codes > 25000
        labels:
          severity: warning
        annotations:
          summary: "Peak pairing codes approaching risk threshold"
          description: "Peak active codes reached {{ $value }}. Plan for capacity."
```

### Risk Level Thresholds (Recommended Updates)

Current thresholds are conservative. Consider:

| Metric | Info | Warning | Critical |
|--------|------|---------|----------|
| Active Codes | 5,000 | 15,000 | 30,000 |
| Collision Rate | 0.01/min | 0.1/min | 1/min |
| Peak Codes (24h) | 10,000 | 25,000 | 35,000 |

---

## Monitoring Dashboard Suggestions

### Key Panels for Grafana Dashboard

#### 1. Real-Time Entropy Status

```
Panel: Single Stat with Background Color
Query: zajel_active_pairing_codes
Thresholds:
  - Green: 0-10000
  - Yellow: 10000-30000
  - Red: >30000
Title: "Active Pairing Codes"
```

#### 2. Collision Risk Gauge

```
Panel: Gauge
Query: zajel_active_pairing_codes / 38600 * 100
Thresholds:
  - Green: 0-25%
  - Yellow: 25-75%
  - Red: 75-100%
Title: "Collision Risk (% of Birthday Bound)"
```

#### 3. Active Codes Over Time

```
Panel: Time Series Graph
Queries:
  - zajel_active_pairing_codes (line)
  - zajel_peak_active_codes (filled area)
Reference Lines:
  - 10000 (low threshold)
  - 20000 (medium threshold)
  - 30000 (high threshold)
Title: "Pairing Code Activity"
```

#### 4. Collision Detection

```
Panel: Time Series + Stat
Queries:
  - rate(zajel_collision_attempts[5m]) (line graph)
  - increase(zajel_collision_attempts[24h]) (stat)
Title: "Collision Attempts"
```

#### 5. Registration Rate

```
Panel: Time Series
Query: rate(zajel_total_registrations[5m])
Title: "Pairing Code Registrations/sec"
```

#### 6. Theoretical Collision Probability

```
Panel: Single Stat
Query: (zajel_active_pairing_codes^2) / (2 * 1073741824) * 100
Format: Percent
Title: "Theoretical Collision Probability"
```

### Recommended Dashboard Layout

```
+-------------------------------------------+
|  Active Codes  |  Risk Gauge  |  Collisions |
|    (Single)    |   (Gauge)    |    (Stat)   |
+-------------------------------------------+
|           Active Codes Over Time           |
|              (Time Series)                 |
+-------------------------------------------+
| Registration Rate |  Collision Rate        |
|   (Time Series)   |   (Time Series)        |
+-------------------------------------------+
```

---

## Prometheus Metric Export Recommendations

To enable the monitoring dashboard, add Prometheus metric exports to the server:

```typescript
// Recommended metrics to export
const metrics = {
  // Gauges
  zajel_active_pairing_codes: new Gauge({
    name: 'zajel_active_pairing_codes',
    help: 'Current number of active pairing codes',
  }),
  zajel_peak_active_codes: new Gauge({
    name: 'zajel_peak_active_codes',
    help: 'Peak number of active pairing codes',
  }),

  // Counters
  zajel_total_registrations: new Counter({
    name: 'zajel_total_registrations',
    help: 'Total number of pairing code registrations',
  }),
  zajel_collision_attempts: new Counter({
    name: 'zajel_collision_attempts',
    help: 'Total number of pairing code collisions detected',
  }),

  // Histogram (optional - for registration timing)
  zajel_pairing_duration_seconds: new Histogram({
    name: 'zajel_pairing_duration_seconds',
    help: 'Time from registration to successful pairing',
    buckets: [1, 5, 10, 30, 60, 120],
  }),
};
```

---

## Future Scaling Recommendations

### If Approaching 30,000 Active Codes

1. **Immediate: Extend code length**
   - Change from 6 to 8 characters
   - New entropy: 40 bits
   - New space: 32^8 = ~1.1 trillion
   - New 50% collision point: ~1.25 million codes

2. **Consider: Reduce timeout**
   - Current: 120 seconds (2 minutes)
   - Reduced: 60 seconds
   - Effect: Halves the active code window

3. **Enhance: Server-side generation**
   - Generate codes server-side
   - Guarantee uniqueness before returning to client
   - Eliminates collision possibility entirely

### Long-Term Architecture Options

1. **Distributed ID generation** (Snowflake-style)
   - Embed server ID in code
   - Eliminate cross-server collisions

2. **Hierarchical codes**
   - Region prefix + random suffix
   - Shards the code space

3. **Time-based codes**
   - Include timestamp component
   - Natural expiration built-in

---

## References

### External Resources

- [Google Meet Security](https://support.google.com/meet/answer/9852160?hl=en)
- [Apple AirDrop Security](https://support.apple.com/guide/security/airdrop-security-sec2261183f4/web)
- [PrivateDrop: AirDrop Privacy Research](https://www.usenix.org/system/files/sec21fall-heinrich.pdf)
- [Birthday Problem - Wikipedia](https://en.wikipedia.org/wiki/Birthday_problem)
- [NIST SP 800-63B: Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)

### Internal Documentation

- [Issue #41 Original Analysis](/home/meywd/zajel/docs/issues/issue-041-code-entropy.md)
- [PR Review Issues](/home/meywd/zajel/PR_REVIEW_ISSUES.md)

---

## Conclusion

The current entropy monitoring implementation in Zajel is well-designed with:
- Collision detection with client notification
- Threshold-based logging at risk boundaries
- HTTP metrics endpoint for monitoring
- Centralized threshold constants

**Key findings:**
1. 30-bit entropy is adequate for current scale (<30,000 active codes)
2. Collision detection is properly implemented
3. Industry comparison shows Zajel is within norms for short-lived codes
4. Monitoring dashboard should be implemented for production visibility
5. Have a plan ready to extend to 8-character codes if scale approaches 30,000

**Action items:**
- [ ] Implement Prometheus metric exports
- [ ] Create Grafana dashboard with suggested panels
- [ ] Configure alerting rules in AlertManager
- [ ] Document runbook for high-entropy alerts
- [ ] Test code length extension procedure in staging
