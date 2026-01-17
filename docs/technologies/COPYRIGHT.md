# Zajel IP & Copyright Analysis

> Last Updated: January 2025  
> Risk Level: **LOW**

## Executive Summary

Zajel uses well-established, royalty-free technologies and open-source libraries. No direct copyright concerns identified. The core features are based on open standards, public domain algorithms, and permissively licensed libraries.

---

## 1. Cryptographic Algorithms

### X25519 / Curve25519
| Attribute | Value |
|-----------|-------|
| Designer | Daniel J. Bernstein (2005) |
| Status | **Public domain**, not covered by any known patents |
| Reference | https://cr.yp.to/ecdh.html |
| FIPS Status | Approved for US Federal Government (SP 800-186, 2023) |

### ChaCha20-Poly1305
| Attribute | Value |
|-----------|-------|
| Designer | Daniel J. Bernstein |
| Status | **IETF standardized** (RFC 8439), royalty-free |
| Adoption | Google TLS, WireGuard, OpenSSH, Apple iOS, Linux kernel |

### Ed25519
| Attribute | Value |
|-----------|-------|
| Designer | Daniel J. Bernstein et al. |
| Status | **Public domain**, FIPS 186-5 approved |
| Reference | https://ed25519.cr.yp.to/ |

**Conclusion**: All cryptographic primitives are public domain or royalty-free standards.

---

## 2. WebRTC

### License & Patent Grant
- **License**: BSD 3-Clause
- **Patent Grant**: Perpetual, worldwide, no-charge, royalty-free
- **Source**: https://webrtc.org/support/license

### W3C Patent Policy
- No patent disclosures for WebRTC specifications
- Source: https://www.w3.org/groups/wg/webrtc/ipr/

### Relevant Patents (NOT Applicable to Zajel)
| Patent | Coverage | Zajel Impact |
|--------|----------|--------------|
| US9781167B2 (Verizon) | WebRTC + IMS/RCS integration | Not applicable |
| US11100197 | Secure RTC with DRM | Not applicable |
| US20240022616 | 5G media streaming | Not applicable |

**Conclusion**: Zajel's WebRTC usage is covered by Google's royalty-free patent grant.

---

## 3. Third-Party Libraries

### Web Client (packages/web-client)
| Library | Version | License | Purpose |
|---------|---------|---------|---------|
| @noble/ciphers | ^0.5.0 | MIT | ChaCha20-Poly1305 |
| @noble/curves | ^1.3.0 | MIT | X25519 ECC |
| @noble/hashes | ^1.3.3 | MIT | SHA-256, HKDF |
| preact | ^10.19.0 | MIT | UI framework |
| vite | ^7.3.1 | MIT | Build tool |

### VPS Server (packages/server-vps)
| Library | Version | License | Purpose |
|---------|---------|---------|---------|
| @noble/ed25519 | ^2.1.0 | MIT | ED25519 signatures |
| @noble/hashes | ^1.6.1 | MIT | SHA-256 hashing |
| better-sqlite3 | ^11.7.0 | MIT | SQLite database |
| ws | ^8.16.0 | MIT | WebSocket server |
| pino | ^9.6.0 | MIT | Logging |

### Flutter App (packages/app)
| Library | Version | License | Purpose |
|---------|---------|---------|---------|
| flutter_webrtc | ^0.12.12 | MIT | WebRTC for mobile |
| cryptography | ^2.7.0 | Apache-2.0 | Crypto primitives |
| flutter_riverpod | ^2.6.1 | MIT | State management |
| sqflite | ^2.4.1 | BSD | SQLite |
| web_socket_channel | ^3.0.3 | BSD | WebSocket client |

**Conclusion**: No GPL/AGPL dependencies. All compatible with proprietary/commercial use.

---

## 4. Federation Protocol

### SWIM Gossip Protocol
| Attribute | Value |
|-----------|-------|
| Origin | Academic paper (2002) |
| Status | No patents, freely implementable |
| Reference Impl | HashiCorp Serf/Consul (open source, MPL-2.0) |

### Consistent Hashing / Kademlia DHT
| Attribute | Value |
|-----------|-------|
| Origin | Academic papers (1997/2002) |
| Status | No known patents |
| Usage | BitTorrent, IPFS, Ethereum |

**Conclusion**: These are academic algorithms with no patent encumbrance.

---

## 5. Competitor Analysis

### Signal Protocol - NOT USED
| Attribute | Value |
|-----------|-------|
| License | **AGPL-3.0** (viral license) |
| Architecture | Double Ratchet with X3DH |
| Zajel Approach | Session-based X25519 + ChaCha20-Poly1305 |

**Important**: Zajel does NOT use Signal Protocol. Our encryption is architecturally different:
- Signal: Complex ratcheting for long-lived conversations
- Zajel: Simple ephemeral session keys for P2P connections

### Comparison with Competitors
| App | Encryption | Architecture | IP Risk |
|-----|------------|--------------|---------|
| Signal | Double Ratchet (AGPL) | Centralized | None - different approach |
| Session | Signal fork | Decentralized (onion) | None - different approach |
| Briar | Custom | P2P via Tor | None - different approach |
| Wire | Signal Protocol | Centralized | None - different approach |
| Matrix | Olm/Megolm | Federated | None - different approach |

---

## 6. Pairing Code System

### Patent Landscape
- Apple QR pairing patents: Cover Apple Watch-specific processes
- Uniloc vs Apple (2018): Targeted dual-channel authentication
- **Zajel approach**: Simple 6-character code via WebSocket (standard rendezvous)

**Conclusion**: Not covered by specific patents.

---

## 7. File Transfer

- Basic chunked file transfer over WebRTC data channels
- Standard usage demonstrated in Google's WebRTC samples
- Not covered by Dropbox/AirDrop patents (which target cloud sync)

---

## 8. Open Standards Compliance

| Feature | Standard | Status |
|---------|----------|--------|
| Encryption | IETF RFC 8439 | Royalty-free |
| Key Exchange | IETF RFC 7748 | Royalty-free |
| WebRTC | W3C/IETF | Royalty-free |
| Signatures | FIPS 186-5 | Royalty-free |

---

## 9. Risk Summary

| Component | Risk | Notes |
|-----------|------|-------|
| Cryptography | **NONE** | Public domain algorithms |
| WebRTC | **NONE** | Google patent grant |
| Libraries | **NONE** | All MIT/BSD/Apache-2.0 |
| Federation | **NONE** | Academic algorithms |
| Pairing codes | **VERY LOW** | Standard approach |
| File transfer | **VERY LOW** | Standard WebRTC usage |
| Signal Protocol | **NONE** | Not used |

---

## 10. References

- [WebRTC License](https://webrtc.org/support/license)
- [W3C WebRTC IPR Policy](https://www.w3.org/groups/wg/webrtc/ipr/)
- [Curve25519](https://en.wikipedia.org/wiki/Curve25519)
- [ChaCha20-Poly1305 RFC 8439](https://tools.ietf.org/html/rfc7539)
- [Noble Cryptography](https://paulmillr.com/noble/)
- [Signal Protocol](https://en.wikipedia.org/wiki/Signal_Protocol)
- [Matrix FAQ](https://matrix.org/docs/older/faq/)
- [Kademlia](https://en.wikipedia.org/wiki/Kademlia)
- [HashiCorp Serf](https://github.com/hashicorp/serf)
