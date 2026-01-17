# VoIP Implementation - Agent Task Overview

## Goal
Add voice and video calling to Zajel using WebRTC with DTLS-SRTP encryption.

## Task Files
Each file is a self-contained task for one agent:

| File | Track | Can Start After | Estimated |
|------|-------|-----------------|-----------|
| `01_PROTOCOL.md` | Foundation | Immediately | ~80 lines |
| `02_SERVER_HANDLER.md` | Server | 01 complete | ~50 lines |
| `03_WEB_MEDIA.md` | Web | Immediately | ~100 lines |
| `04_WEB_SIGNALING.md` | Web | 01 complete | ~60 lines |
| `05_WEB_VOIP.md` | Web | 03, 04 complete | ~200 lines |
| `06_WEB_UI.md` | Web | 05 complete | ~300 lines |
| `07_FLUTTER_MEDIA.md` | Flutter | Immediately | ~100 lines |
| `08_FLUTTER_SIGNALING.md` | Flutter | 01 complete | ~60 lines |
| `09_FLUTTER_VOIP.md` | Flutter | 07, 08 complete | ~200 lines |
| `10_FLUTTER_UI.md` | Flutter | 09 complete | ~300 lines |

## Dependency Graph

```
        01_PROTOCOL (foundation)
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
02_SERVER  04_WEB_SIG  08_FLUTTER_SIG
              │              │
03_WEB_MEDIA  │    07_FLUTTER_MEDIA
    │         │         │    │
    └────┬────┘         └──┬─┘
         ▼                 ▼
    05_WEB_VOIP      09_FLUTTER_VOIP
         │                 │
         ▼                 ▼
    06_WEB_UI        10_FLUTTER_UI
```

## Parallel Execution Strategy

**Wave 1 (Start immediately):**
- 01_PROTOCOL
- 03_WEB_MEDIA
- 07_FLUTTER_MEDIA

**Wave 2 (After 01 completes):**
- 02_SERVER_HANDLER
- 04_WEB_SIGNALING
- 08_FLUTTER_SIGNALING

**Wave 3 (After dependencies):**
- 05_WEB_VOIP (needs 03 + 04)
- 09_FLUTTER_VOIP (needs 07 + 08)

**Wave 4 (After services):**
- 06_WEB_UI
- 10_FLUTTER_UI

## Coordination Rules

1. **No cross-task file edits** - Each task owns specific files
2. **Protocol is the contract** - All tasks depend on types from 01
3. **Tests included** - Each task includes its own tests
4. **Mark complete** - Update this file when done
