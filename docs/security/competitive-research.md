# Competitive Research: Build Signing, Federation Security, and Key Management

**Date:** 2026-03-03
**Scope:** Industry analysis of security patterns relevant to Zajel's federation registry, build attestation, and P2P encryption

---

## 1. Sigstore / Cosign — Keyless Build Signing and Transparency

### What it does

Sigstore eliminates long-lived signing keys entirely through "keyless" (identity-based) signing. The system consists of three components:

- **Cosign**: CLI tool for signing and verifying container images and other artifacts.
- **Fulcio**: A certificate authority that issues short-lived signing certificates (valid ~20 minutes) based on OIDC identity verification (Google, GitHub, Microsoft).
- **Rekor**: An immutable, append-only transparency log that records all signing events for public auditability, built on a verifiable data structure (Merkle tree).

The signing flow: a user authenticates via OIDC, Fulcio issues a short-lived certificate binding their identity to an ephemeral keypair, the artifact is signed, the signature is recorded in Rekor, and the private key is immediately discarded. The private key never hits disk and is never known by Sigstore services. Verification later uses the transparency log entry and certificate chain rather than the original key.

### Key rotation strategy

There is none needed for individual signers — that is the entire point. Ephemeral keys live only for the duration of signing (~20 minutes). Sigstore's own root of trust (Fulcio's root CA certificate, Rekor's public key) is distributed via TUF, established through a public root key signing ceremony with five keyholders from different organizations.

### Attack vectors mitigated

- Key compromise (keys don't persist to be compromised)
- Key distribution problems (no public keys to distribute)
- Unauthorized signing (tied to OIDC identity)
- Signing event tampering (transparency log is append-only and auditable)
- Mis-issued certificates (Fulcio must publish all certs to the log; clients reject certs not in the log)

### Limitations

- OIDC provider dependency (currently only Google, GitHub, Microsoft out of the box)
- Transparency means metadata exposure (user identities, repository info are public)
- Primary tooling focus on GitHub Actions; weaker support for Jenkins, Azure Pipelines
- Attestation storage challenges for non-container artifacts (executables, JARs, Python packages)

### Applicability to Zajel

Sigstore's model is highly relevant for signing federation server registry entries. Rather than requiring servers to manage long-lived signing keys, each server could prove its identity through an OIDC-like mechanism (or a self-hosted Fulcio instance) and have its registration signed with ephemeral keys. The transparency log concept is directly applicable — a registry of federation servers could use an append-only log so that any observer can detect if a server entry was tampered with or fraudulently added.

**Sources:**
- [Sigstore Overview](https://docs.sigstore.dev/about/overview/)
- [Sigstore Security Model](https://docs.sigstore.dev/about/security/)
- [Rekor Transparency Log](https://docs.sigstore.dev/logging/overview/)
- [Cosign on GitHub](https://github.com/sigstore/cosign)
- [Sigstore Keyless Signing — Giant Swarm](https://www.giantswarm.io/blog/securing-the-software-supply-chain-with-sigstore-giant-swarm)
- [OpenSSF — Scaling Up Supply Chain Security with Sigstore](https://openssf.org/blog/2024/02/16/scaling-up-supply-chain-security-implementing-sigstore-for-seamless-container-image-signing/)

---

## 2. The Update Framework (TUF) — Key Hierarchies and Compromise Recovery

### What it does

TUF provides a framework for secure software update systems using a hierarchy of four top-level roles, each with its own keys and responsibilities:

| Role | Purpose | Key Type | Update Frequency |
|------|---------|----------|-----------------|
| **Root** | Delegates trust to all other roles; can revoke/rotate any key | Offline, highest security | Rarely (expiry ~1 year) |
| **Targets** | Signs metadata about which target files are trusted | Offline or online | When targets change |
| **Snapshot** | Lists version numbers/hashes of all targets metadata; ensures consistent view | Online (can be offline) | When any metadata changes |
| **Timestamp** | Signs hash/size of snapshot.json; first file clients check | Online, auto-rotated | Frequently (expiry ~1 day) |

### Threshold signing

Each role specifies a THRESHOLD — the minimum number of unique key signatures required to consider metadata validly signed. For example, the root role might require 3-of-5 keyholders to sign, while timestamp requires only 1. Each signature counted toward the threshold must come from a unique KEYID — even if a key appears multiple times, it only counts once.

### Key compromise recovery

- **Online key compromise (Timestamp/Snapshot/Targets):** The Root role revokes the compromised key and signs new root metadata with the replacement. This is a normal key rotation.
- **Root key compromise (below threshold):** Normal rotation — the remaining trusted root keyholders sign a new root.json revoking the compromised key.
- **Root key compromise (at or above threshold):** Requires out-of-band recovery (e.g., manual distribution of new root keys). TUF acknowledges this is nearly impossible to recover from safely, which is why offline storage and high thresholds for root keys are critical.
- **Fast-forward attack recovery:** If an attacker with compromised snapshot/timestamp keys sets artificially high version numbers (denying future updates), clients must delete their cached timestamp and snapshot metadata to reset.

### Attack vectors mitigated

- Arbitrary software installation (targets role limits what's trusted)
- Rollback attacks (version numbers in snapshot prevent serving old metadata)
- Freeze attacks (short-lived timestamp metadata forces freshness checks)
- Indefinite key trust (metadata expiration forces regular renewal)
- Single point of compromise (role separation means one compromised key doesn't give full control)
- Mix-and-match attacks (snapshot ensures consistent view of all metadata)

### Applicability to Zajel

TUF's role hierarchy is directly applicable to a federation server registry:
- A **root role** (offline keys held by project maintainers) to bootstrap trust.
- A **targets role** to sign the list of registered federation servers.
- A **snapshot role** to ensure clients see a consistent registry state.
- A **timestamp role** (online, auto-rotated) to prove the registry is fresh.

Threshold signing ensures no single compromised maintainer can corrupt the registry. Notably, Sigstore itself uses TUF to distribute its root of trust.

**Sources:**
- [TUF Specification](https://theupdateframework.github.io/specification/latest/)
- [TUF Roles and Metadata](https://theupdateframework.io/docs/metadata/)
- [TUF Security](https://theupdateframework.io/docs/security/)
- [TUF FAQ](https://theupdateframework.io/docs/faq/)
- [Survivable Key Compromise in Software Update Systems (Academic Paper)](https://www.freehaven.net/~arma/tuf-ccs2010.pdf)

---

## 3. Docker Content Trust / Notary v2 — Image Signing and Delegation

### What it does

Docker Content Trust (DCT) was built on the Notary project, which itself is built on TUF. It provided a system for signing and verifying container images with a hierarchical key model.

### Key hierarchy (online vs. offline)

- **Root key:** Offline. The root of all trust, used to create new image repositories and rotate all other keys.
- **Targets key:** Per-repository. Needed for new signatures on a specific image repository.
- **Delegation keys:** Go one level deeper — they can sign individual images and only need the targets key (not root) for rotation.
- **Snapshot key:** Server-managed (online) after the first delegation is added.
- **Timestamp key:** Server-managed (online), automatically rotated.

### Current status

DCT was retired on August 8, 2025, when the oldest signing certificates for Docker Official Images started expiring. The upstream Notary v1 project was archived on July 30, 2025. Docker recommends migration to Sigstore or Notation (Notary v2).

### Notary v2 (Notation)

Key differences from v1:
- Supports **multiple signatures** per image (v1 only supported one), enabling approval chains.
- Specification-driven, cross-registry, OCI-native.
- Integrates into existing PKI rather than requiring a standalone Notary server infrastructure.
- Still uses a hierarchical trust model with trust stores and trust policies.

### Applicability to Zajel

The delegation model is relevant for a federation registry where different authorities might need to approve server registrations. The online/offline key separation pattern (root keys offline, operational keys online) is a proven model. However, the lesson from DCT's retirement is that self-hosted signing infrastructure (Notary server + signer + MySQL + mTLS) is operationally expensive. Simpler models (like Sigstore's keyless approach) have won in practice.

**Sources:**
- [Docker Content Trust Documentation](https://docs.docker.com/engine/security/trust/)
- [Docker Content Trust Delegation](https://docs.docker.com/engine/security/trust/trust_delegation/)
- [Docker Content Trust Retired — InfoQ](https://www.infoq.com/news/2025/08/docker-content-trust-retired/)
- [Signing Container Images: Comparing Sigstore, Notary, and DCT — Snyk](https://snyk.io/blog/signing-container-images/)

---

## 4. Cloudflare Workers / Durable Objects Security

### Runtime security model

Cloudflare Workers use V8 isolates (not containers or VMs) for multi-tenant isolation:

- **Timing attack mitigation:** `Date.now()` is locked during execution. No other timers provided. No access to concurrency/multi-threading. Resistant to Spectre-style attacks.
- **Memory protection keys:** Internal V8 modifications use CPU memory protection keys to isolate isolates. Each isolate receives a random key protecting its V8 heap data. Security bugs that might allow cross-isolate reads hit a hardware trap in 92% of cases.
- **V8 sandbox:** Each isolate group has its own sandbox.
- **No native code:** Workers only accepts JavaScript and WebAssembly.

### Durable Objects specific security

- All DO data (including metadata) is **encrypted at rest** using LUKS/AES-256, automatically and without performance impact.
- Data transfer between Workers and DOs is secured with TLS/SSL.
- DOs are **not directly internet-accessible**. Only reachable via Workers bindings through an RPC mechanism using **Object Capabilities (capability-based security)**.
- Each DO runs in exactly one location, in one single thread, with its own private on-disk storage (up to 10 GB).

### Known attack vectors (application-level, not platform-level)

- **Predictable Object IDs:** Using `idFromName()` with guessable names could allow unauthorized access if the calling Worker doesn't authenticate requests.
- **Cross-request state leaks:** Workers reuse isolates across requests. Module-level variables persist between requests, potentially leaking data between users. Mitigation: pass state through function arguments or `env` bindings.
- **Version skew:** Code updates are eventually consistent. A request could hit the latest Worker but call a DO still running previous code.
- **Race conditions:** Although single-threaded, `async/await` interleaving can cause subtle race conditions in DOs.
- **No known CVEs:** No publicly documented CVEs, exploits, or data exfiltration vulnerabilities specific to Durable Objects as of 2024-2025.

### Secrets management best practices

- **Per-Worker secrets:** Use `wrangler secret put` (never `vars` in wrangler.toml). Values are not visible in the dashboard after creation.
- **Cloudflare Secrets Store (account-level):** Centralized, encrypted across all data centers. Uses a **two-level key hierarchy** — DEKs encrypt secrets, a separate KEK encrypts the DEKs. The root key never leaves the secure system. Once created, secret values are not readable by anyone.
- **Local development:** `.dev.vars` or `.env` files (must be in `.gitignore`).

### Rate limiting

- **Workers Rate Limiting Binding:** Per Cloudflare location (not globally consistent). Permissive and eventually consistent.
- **WAF Rate Limiting:** Edge-level, across 330+ cities. Blocks traffic before it reaches origin.

### Applicability to Zajel

1. DO IDs must use unpredictable identifiers or enforce authentication at the Worker layer.
2. Secrets for signing keys should use the Secrets Store with its two-level key hierarchy, not environment variables.
3. Rate limiting is eventually consistent and per-location — globally coordinated rate limits require a dedicated DO per-identity tracking request counts.
4. The biggest risk is application-level logic bugs, not platform-level exploits.

**Sources:**
- [Cloudflare Workers Security Model](https://developers.cloudflare.com/workers/reference/security-model/)
- [Durable Objects Data Security](https://developers.cloudflare.com/durable-objects/reference/data-security/)
- [Safe in the Sandbox: Security Hardening for Workers](https://blog.cloudflare.com/safe-in-the-sandbox-security-hardening-for-cloudflare-workers/)
- [Workers RPC Visibility and Security](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)
- [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/)
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

---

## 5. WebRTC Federation Security — Matrix, Jitsi, and Server Identity

### Matrix.org Federation

**Server identity verification** uses a multi-layered approach:

1. **Ed25519 signing keys:** Each homeserver publishes its signing keys at `/_matrix/key/v2/server`. These keys sign federation requests and events.
2. **TLS certificates:** Post-MSC1711 (Synapse 1.0+), Matrix requires valid CA-issued TLS certificates. Self-signed certificates are no longer accepted.
3. **Notary server system (deprecated in practice):** Borrowed from the Perspectives Project. Servers could query multiple "notary" servers to corroborate a target server's keys.

**Why the Perspectives approach failed:**
- **Sybil vulnerability:** An attacker controlling multiple notary servers could present false keys and achieve majority consensus. Requiring unanimity enables DoS by any single dissenting notary.
- **Practical centralization:** Nearly all Matrix implementations defaulted to trusting only `matrix.org` as a notary.
- **Result:** Matrix moved to standard X.509/TLS CA-based verification.

**TOFU was considered but rejected** for federation — a self-signed certificate makes MITM too easy on first connection.

### Jitsi Meet

**P2P encryption:** For 1-to-1 calls, DTLS-SRTP encrypts audio/video end-to-end.

**Multi-party E2EE:** Uses JFrame (a variant of SFrame) with AES-GCM-128 via WebCrypto API.

**Critical vulnerability:** Jitsi's design provides **no mechanisms to independently verify either party's identity**. The XMPP server handles WebRTC signaling (including self-signed TLS certificate fingerprints in SDP). A compromised XMPP server can trivially modify signaling messages, tricking both parties into connecting to an attacker-controlled endpoint. Partially mitigated by introducing SAS (Short Authentication Strings) verification.

**Key lesson:** Chat/text messaging is NOT covered by Jitsi's E2EE — only audio, video, and screen-sharing.

### Attack vectors across federated WebRTC systems

| Attack | Description | Mitigation |
|--------|-------------|------------|
| **MITM via signaling** | Compromised signaling server modifies SDP offers/answers | SAS verification, out-of-band key verification |
| **Sybil attack on notaries** | Attacker runs many notary servers to control key consensus | Use CA-based TLS, limit notary trust |
| **DNS spoofing** | Redirect federation traffic to attacker server | DNSSEC, certificate pinning |
| **Key fabrication for offline servers** | Other servers can fabricate keys for an offline server | Require direct server contact; cache with short TTLs |
| **Metadata leakage** | Signaling reveals who is communicating with whom | Tor/onion routing (Briar, Session approaches) |

### Applicability to Zajel

1. **Do not use TOFU** for server identity — Matrix's experience confirms it's too easy to MITM.
2. **Do not rely on Perspectives-style notary consensus** — it devolves into centralization or is vulnerable to Sybil attacks.
3. **Use CA-verified TLS + Ed25519 signing keys** — TLS proves domain ownership, signing key proves the server produced specific messages.
4. **Verify signaling integrity** — Jitsi's vulnerability shows WebRTC signaling servers that modify SDP are a critical MITM vector. Sign SDP offers/answers with the server's Ed25519 key.
5. **SAS/safety numbers** for peer verification remain important as a last line of defense.

**Sources:**
- [Matrix Server-Server API Specification](https://spec.matrix.org/v1.9/server-server-api/)
- [MSC1711: X.509 Certificate Verification for Federation](https://github.com/matrix-org/matrix-spec-proposals/pull/1711)
- [Matrix Federation Public Key System Security Issue #383](https://github.com/matrix-org/matrix-spec/issues/383)
- [Jitsi Meet Security & Privacy](https://jitsi.org/security/)
- [Practically-exploitable Vulnerabilities in Jitsi (Academic Paper)](https://eprint.iacr.org/2023/1118.pdf)
- [Jitsi E2EE](https://jitsi.org/e2ee-in-jitsi/)
- [Security Evaluation of Matrix Server-Server API (KTH Paper)](https://kth.diva-portal.org/smash/get/diva2:1845152/FULLTEXT01.pdf)

---

## 6. SLSA Framework — Supply Chain Security Levels

### What it is

Supply-chain Levels for Software Artifacts (SLSA, "salsa") is a security framework originally proposed by Google in 2021 (latest spec v1.2). It defines progressive security levels across tracks.

### Build Track Levels

| Level | Name | Key Requirements |
|-------|------|-----------------|
| **L0** | No SLSA | No provenance |
| **L1** | Provenance exists | Build provenance describing platform, process, inputs. May be unsigned. |
| **L2** | Hosted, signed provenance | Builds run on dedicated infrastructure. Provenance is signed by the build platform. |
| **L3** | Hardened builds | Isolated, ephemeral build environments. Provenance is non-falsifiable. Signing keys inaccessible to user-defined build steps. |

### SLSA Level 3 in detail

1. **Isolated builds:** Each build runs in a dedicated container or VM created specifically for that build. Environments must not be reused.
2. **Ephemeral environments:** Build infrastructure is short-lived — provisioned on demand, destroyed after.
3. **Non-falsifiable provenance:** Provenance is generated by the build platform's control plane, not by user code. The signing secret is not accessible to individual build steps.
4. **Provenance format:** in-toto attestation with SLSA Provenance predicate (JSON), distributed as a signed DSSE envelope.

### What L3 does NOT require

- **Hermetic builds** (all dependencies fully specified upfront, no network access) — originally L4 in v0.1, deferred to beyond L3 in v1.0.

### Applicability to Zajel

1. Achieve at minimum SLSA L2 — ensure builds run on hosted CI with signed provenance.
2. Target L3 for releases — use GitHub Actions with ephemeral runners, ensure signing keys are not accessible to build steps (use Sigstore keyless signing).
3. Publish provenance attestations alongside releases.
4. For the federation registry itself, SLSA provenance ensures operators can verify they're running untampered code.

**Sources:**
- [SLSA Official Site](https://slsa.dev/)
- [SLSA Security Levels](https://slsa.dev/spec/v1.0/levels)
- [SLSA Requirements for Producing Artifacts](https://slsa.dev/spec/v1.0/requirements)
- [SLSA Specification v1.2](https://slsa.dev/spec/v1.2/)
- [GitHub Artifact Attestations for SLSA L3](https://github.blog/enterprise-software/devsecops/enhance-build-security-and-reach-slsa-level-3-with-github-artifact-attestations/)
- [Introduction to SLSA — Chainguard Academy](https://edu.chainguard.dev/compliance/slsa/what-is-slsa/)

---

## 7. NIST SP 800-57 — Key Management Best Practices

### What it covers

NIST SP 800-57 (Rev. 5 final, Rev. 6 draft December 2025) provides comprehensive guidance on cryptographic key management across the entire lifecycle.

### Key lifecycle phases

| Phase | Description | Key Risks |
|-------|-------------|-----------|
| **Generation** | Must use approved algorithms, FIPS-validated RNGs, secure environments | Weak randomness, predictable keys |
| **Distribution** | Secure transport of keys to authorized entities | Interception, unauthorized access |
| **Storage** | Protection at rest (encryption, HSMs, access controls) | Theft, unauthorized copying |
| **Usage** | Active use for cryptographic operations | Side-channel attacks, misuse |
| **Rotation** | Replacement per cryptoperiod or event-triggered | Disruption, inconsistent state |
| **Archiving** | Retained for verification of old data (not for new operations) | Unauthorized re-activation |
| **Destruction** | Irreversible removal when no longer needed | Incomplete destruction, recovery |

### Key principles

- **Key separation:** Use different keys for different functions (one for encryption, another for signing). Never reuse across purposes.
- **Cryptoperiods:** Defined lifespan during which a key is valid. Schedule rotation based on key age or volume of data processed.
- **Revocation:** Symmetric keys use Compromised Key Lists (CKLs). Asymmetric keys use CRLs or OCSP (OCSP preferred for lower latency).

### Emergency response for key compromise

1. Immediately rotate affected keys
2. Re-encrypt any data secured with compromised keys
3. Audit for unauthorized access during the compromise window
4. Update all systems consuming the compromised key

### Applicability to Zajel

1. **Key separation:** Zajel already separates key exchange (X25519) from signing (Ed25519) — aligns with NIST guidance.
2. **Ephemeral session keys:** Per-session ephemeral key exchange naturally limits cryptoperiods — the strongest possible rotation policy.
3. **Signing key rotation:** Ed25519 keys for federation server identity should have defined cryptoperiods. Short-lived for online operations, longer-lived for offline/root.
4. **Revocation for federation:** If a federation server's signing key is compromised, the registry needs a revocation mechanism (revocation list, short-lived certificates, or TUF-style metadata expiration).
5. **Key destruction:** When sessions end, ephemeral keys must be irreversibly destroyed (zeroed from memory).
6. **HKDF usage:** Zajel's use of HKDF for key derivation aligns with NIST-approved constructs.

**Sources:**
- [NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)
- [NIST SP 800-57 Part 1 Rev. 6 (Draft)](https://csrc.nist.gov/pubs/sp/800/57/pt1/r6/ipd)
- [NIST SP 800-57 Part 2 Rev. 1](https://csrc.nist.gov/pubs/sp/800/57/pt2/r1/final)
- [NIST Key Management Guidelines](https://csrc.nist.gov/projects/key-management/key-management-guidelines)
- [CMS Key Management Handbook](https://security.cms.gov/learn/cms-key-management-handbook)

---

## Cross-Cutting Synthesis: Architectural Lessons for Zajel

### 1. Prefer ephemeral/short-lived keys over long-lived keys wherever possible
Sigstore proved that ephemeral keys tied to identity eliminate entire classes of key management problems. For Zajel's session encryption, this is already the model. For federation server identity, consider short-lived certificates (hours/days) renewed automatically.

### 2. Use TUF for registry trust distribution
TUF's role hierarchy with threshold signing is the proven standard for distributing trusted metadata. A federation registry is essentially a "software update" problem — servers need the latest trusted list of other servers.

### 3. Do not rely on Perspectives/notary consensus
Matrix's experience is definitive: the Perspectives model either centralizes in practice or is vulnerable to Sybil attacks. Use CA-verified TLS for domain identity and Ed25519 for message signing.

### 4. Separate online and offline keys with clear role boundaries
Root keys should be offline (held by multiple keyholders with threshold signing), while operational keys are online and short-lived.

### 5. Sign WebRTC signaling to prevent MITM
Jitsi's vulnerability is a direct warning: any system where the signaling server can modify SDP offers/answers without detection is vulnerable. Cryptographically sign SDP offers/answers with the peer's Ed25519 key.

### 6. Use append-only transparency logs for auditability
Rekor's model is directly applicable to a federation registry. Any server registration, key rotation, or revocation should be logged transparently.

### 7. For Cloudflare Workers/DO: focus on application-level security
The platform is well-hardened. Risks are in application code: predictable DO IDs, cross-request state leaks, missing authentication on RPC calls. Use the Secrets Store for signing keys.

### 8. Target SLSA L3 for build provenance
Zajel builds should produce signed, non-falsifiable provenance attestations. Use GitHub Actions with Sigstore keyless signing to achieve this without managing long-lived build signing keys.
