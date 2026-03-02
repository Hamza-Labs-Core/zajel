# Zajel Refactor Plans — Master Overview

Full branch scan performed on `feat/plan05-channels-groups` (213 commits, 586 files, ~94K lines).
4 parallel review agents analyzed architecture, security, server code, and test coverage.

## Scan Summary

| Dimension | Findings | Critical | High | Medium | Low |
|-----------|----------|----------|------|--------|-----|
| Architecture | 20 | 2 | 6 | 9 | 3 |
| Security | 17 | 1 | 4 | 8 | 4 |
| Server Code | 19 | 0 | 1 | 10 | 8 |
| Test Coverage | — | 4 critical gaps | — | — | — |

## Phase Overview

| Phase | File | Items | Effort | Risk |
|-------|------|-------|--------|------|
| [Phase 1](phase1-quick-wins.md) | Quick Wins | 5 | Low | Low-Medium |
| [Phase 2](phase2-medium-effort.md) | Medium Effort | 6 | Medium | Low-Medium |
| [Phase 3](phase3-major-refactors.md) | Major Refactors | 5 | High | Medium-High |

## Execution Waves

### Phase 1 Waves

| Wave | Items | Parallel? |
|------|-------|-----------|
| 1A | Fix cross-layer import, Guard E2E_TEST | Yes |
| 1B | Error boundary handleDisconnect | Solo |
| 1C | Schema validation (server) | Solo |
| 1D | HKDF salt (cross-platform) | Solo (last) |

### Phase 2 Waves

| Wave | Items | Parallel? |
|------|-------|-----------|
| 2A | Read receipt tests, Typing indicator tests | Yes |
| 2B | TTL upstream queues, Protect /stats, Fix CORS | Yes (all server) |
| 2C | Split app_providers.dart | Solo |

### Phase 3 Waves

| Wave | Items | Parallel? |
|------|-------|-----------|
| 3A | ConnectionManager tests | Solo (safety net) |
| 3B | Break up ConnectionManager, Break up ClientHandler | Yes (Flutter + Server parallel) |
| 3C | Break up _ZajelAppState | Solo |
| 3D | Forward secrecy | Solo (last, highest risk) |

## All Items At a Glance

| # | Item | Phase | Risk | Files Touched |
|---|------|-------|------|---------------|
| 1.1 | Fix cross-layer import (FilteredEmojiPicker) | 1 | Very Low | 2 |
| 1.2 | Add salt to HKDF | 1 | Medium | 8+ (cross-platform) |
| 1.3 | Schema validation on server WS messages | 1 | Low | 1-2 |
| 1.4 | Guard E2E_TEST flag | 1 | Very Low | 2 |
| 1.5 | Error boundary handleDisconnect | 1 | Low | 1 |
| 2.1 | Split app_providers.dart | 2 | Low | 10 (9 new + 1 barrel) |
| 2.2 | Tests for read_receipt_service | 2 | Very Low | 1 new |
| 2.3 | Tests for typing_indicator_service | 2 | Very Low | 1 new |
| 2.4 | TTL upstream queues | 2 | Low | 2 |
| 2.5 | Protect /stats endpoint | 2 | Low | 1 |
| 2.6 | Fix CORS wildcard | 2 | Low | 1-2 |
| 3.1 | Break up _ZajelAppState | 3 | Low | 8 (7 new + main.dart) |
| 3.2 | Break up ConnectionManager | 3 | Medium | 7 (6 new + connection_manager.dart) |
| 3.3 | Break up ClientHandler | 3 | Medium | 9 (8 new + handler.ts) |
| 3.4 | Add forward secrecy | 3 | High | 5+ (cross-platform) |
| 3.5 | Comprehensive ConnectionManager tests | 3 | Low | 1 (expand existing) |

## Critical God Classes

| Class | File | Lines | Target |
|-------|------|-------|--------|
| `_ZajelAppState` | `main.dart` | 1155 | → 150-200 lines + 7 services |
| `ConnectionManager` | `connection_manager.dart` | 1626 | → facade + 6 sub-services (11 stream controllers consolidated) |
| `ClientHandler` | `handler.ts` | 2820 | → facade + 8 sub-handlers |
| **Total** | | **5601** | → ~500 lines orchestration + ~5100 in focused modules |
