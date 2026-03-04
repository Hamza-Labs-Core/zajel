# Plan 12: Video Background Blur

## Context

The Flutter app has a scaffold for background blur (`BackgroundBlurProcessor`) with settings persistence (enabled, strength) and a media settings UI toggle — but `isModelAvailable` is hardcoded to `false` and no actual frame processing exists. The goal is to implement real-time person segmentation and background blur for video calls.

**Key challenge**: Video frames at 720p@30fps produce ~105 MB/s of pixel data. Passing frames through Dart would be prohibitively slow. The solution must operate entirely in native code, intercepting frames in the camera capture pipeline before they reach WebRTC.

---

## Architecture Decision: Native Platform Plugin

`flutter_webrtc 0.12.12` already has native frame processor interfaces that are NOT exposed to Dart:
- **Android**: `ExternalVideoFrameProcessing` in `LocalVideoTrack.java` — receives `VideoFrame`, returns processed `VideoFrame`
- **iOS/macOS**: `ExternalVideoProcessingDelegate` in `VideoProcessingAdapter.h` — receives `CVPixelBuffer`, returns processed `CVPixelBuffer`

**Approach**: Create an in-tree Flutter platform plugin (`zajel_background_blur`) that:
1. Registers as a native frame processor in flutter_webrtc's capture pipeline
2. Runs ML-based person segmentation on each frame (native, no Dart involvement)
3. Applies Gaussian blur to non-person regions
4. Returns the processed frame — flutter_webrtc sends it over WebRTC as normal

The bridge between plugins happens in `MainActivity.kt` (Android) and `AppDelegate.swift` (iOS/macOS) after Flutter engine startup.

---

## Segmentation Engine Per Platform

| Platform | Engine | API | Latency | License |
|----------|--------|-----|---------|---------|
| Android | ML Kit Selfie Segmentation | `SelfieSegmentation.getClient(STREAM_MODE)` | ~8-15ms | MIT (google_mlkit_selfie_segmentation) |
| iOS 15+ | Apple Vision | `VNGeneratePersonSegmentationRequest(.balanced)` | ~10-15ms | System framework |
| macOS 12+ | Apple Vision | Same as iOS | ~10-15ms | System framework |
| Linux/Windows | None | N/A | N/A | Deferred — no native hooks |

---

## File Structure

```
packages/app/
  zajel_background_blur/              # In-tree Flutter plugin
    pubspec.yaml
    lib/
      zajel_background_blur.dart       # Dart API: enable/disable/setStrength
    android/
      src/main/kotlin/.../
        ZajelBackgroundBlurPlugin.kt   # MethodChannel handler
        BlurFrameProcessor.kt          # Implements ExternalVideoFrameProcessing
        SegmentationEngine.kt          # ML Kit wrapper
    ios/
      Classes/
        ZajelBackgroundBlurPlugin.swift
        BlurFrameProcessor.swift       # Implements ExternalVideoProcessingDelegate
        SegmentationEngine.swift       # Vision framework wrapper
    macos/
      Classes/
        (shares ios/Classes/ via symlinks or CocoaPods source)
```

---

## Implementation Phases

### Phase 1: Plugin Scaffold + Android ML Kit (Primary)

**1a. Create plugin structure**

- `zajel_background_blur/pubspec.yaml` — Flutter plugin with Android/iOS/macOS platforms
- `zajel_background_blur/lib/zajel_background_blur.dart` — Dart API:
  ```dart
  class ZajelBackgroundBlur {
    static Future<bool> get isAvailable;           // ML model loaded?
    static Future<void> setEnabled(bool enabled);
    static Future<void> setStrength(double strength); // 0.0-1.0 → blur radius
  }
  ```
- Wire into existing `BackgroundBlurProcessor` — replace hardcoded `isModelAvailable = false`

**1b. Android native implementation**

- `BlurFrameProcessor.kt`:
  - Implements `ExternalVideoFrameProcessing` interface from flutter_webrtc
  - `onFrameProcessed(VideoFrame frame): VideoFrame` — entry point
  - Converts `VideoFrame` → `InputImage` (ML Kit format)
  - Runs segmentation → gets `SegmentationMask` (confidence per pixel)
  - Applies RenderScript or Vulkan Gaussian blur to background region
  - Returns processed `VideoFrame`

- `SegmentationEngine.kt`:
  - Lazy-loads ML Kit selfie segmenter in `STREAM_MODE`
  - Thread-safe: processes one frame at a time, drops frames if busy
  - Configurable confidence threshold (default 0.7)

**1c. Bridge registration in MainActivity.kt**

```kotlin
// After Flutter engine starts:
val webrtcPlugin = flutterEngine.plugins.get(FlutterWebRTCPlugin::class.java)
val blurPlugin = flutterEngine.plugins.get(ZajelBackgroundBlurPlugin::class.java)
blurPlugin.attachToWebRTC(webrtcPlugin)
```

**1d. Wire Dart side**

- Update `BackgroundBlurProcessor`:
  - `isModelAvailable` → delegates to `ZajelBackgroundBlur.isAvailable`
  - `toggleBlur()` → calls `ZajelBackgroundBlur.setEnabled()`
  - `setStrength()` → calls `ZajelBackgroundBlur.setStrength()`
- Update `pubspec.yaml` to add path dependency on `zajel_background_blur`

### Phase 2: iOS Vision Framework

- `BlurFrameProcessor.swift`:
  - Implements `ExternalVideoProcessingDelegate` protocol
  - `processVideoFrame(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer`
  - Runs `VNGeneratePersonSegmentationRequest` with `.balanced` quality
  - Uses Core Image `CIGaussianBlur` + mask compositing
  - Returns processed CVPixelBuffer

- `SegmentationEngine.swift`:
  - Creates VNSequenceRequestHandler for temporal consistency
  - iOS 15+ / macOS 12+ availability check
  - Falls back to disabled if unsupported

- Bridge in `AppDelegate.swift` (same pattern as Android)

### Phase 3: macOS

- Share iOS implementation via CocoaPods podspec `source_files` pointing to `ios/Classes/`
- Both use Vision framework — API is identical
- Only difference: bridge point is `MainFlutterWindow` instead of `AppDelegate`

### Phase 4: Desktop (Linux/Windows) — Deferred

- `isAvailable` returns `false` on unsupported platforms
- Future options: TFLite C++ via custom model, or MediaPipe
- No flutter_webrtc native hooks exist for these platforms currently

---

## Call UI Integration

**File**: `packages/app/lib/features/call/call_screen.dart`

Add blur toggle button to call controls bar (alongside mute, video, flip, settings, hangup):

```dart
IconButton(
  icon: Icon(blurEnabled ? Icons.blur_on : Icons.blur_off),
  tooltip: 'Background blur',
  onPressed: blurAvailable ? () => toggleBlur() : null,
)
```

- Only visible when `isAvailable == true` (model loaded)
- Reads/writes state via `BackgroundBlurProcessor` provider
- Persisted across calls (already handled by settings storage)

---

## Performance Budget

| Metric | Target | Fallback |
|--------|--------|----------|
| Segmentation latency | < 15ms per frame | Drop frames, process every 2nd/3rd |
| Total pipeline overhead | < 20ms (33ms budget at 30fps) | Reduce to 15fps processing |
| Memory (ML model) | < 50MB | Lazy load, release when blur disabled |
| Battery impact | < 15% increase | Auto-disable on low battery (future) |

**Frame dropping strategy**: If segmentation takes longer than frame interval, skip frames and reuse previous mask. Person silhouettes don't change drastically frame-to-frame.

---

## Testing Strategy

1. **Unit tests** (Dart): `BackgroundBlurProcessor` state management, enable/disable/strength persistence
2. **Integration tests** (Android): ML Kit model loads, segmentation produces non-null mask
3. **Integration tests** (iOS): Vision framework available on iOS 15+, produces segmentation
4. **Manual testing**: Visual verification of blur quality on real devices
5. **Performance profiling**: Frame timing logs to verify < 15ms budget

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| flutter_webrtc native API changes | Pin version, wrap interface access in try/catch |
| ML Kit model download required | ML Kit bundles model in APK (no network needed) |
| Plugin-to-plugin bridge fragile | Clear error if bridge fails, blur just stays unavailable |
| Memory pressure on low-end devices | Lazy-load model, release when disabled |
| Frame format incompatibility | Convert between I420/NV21/BGRA as needed per platform |

---

## Dependencies

- `google_mlkit_selfie_segmentation: ^0.10.0` (Android only, MIT license)
- No new iOS/macOS dependencies (Vision is a system framework)
- flutter_webrtc 0.12.12 (already in use)

---

## Verification

1. `flutter build apk --release` — builds with blur plugin
2. `flutter build ios --release` — builds with blur plugin
3. `flutter test` — existing + new unit tests pass
4. Manual: Start video call on Android → toggle blur → background blurred, face sharp
5. Manual: Start video call on iOS → toggle blur → same behavior
6. Manual: Check Linux/Windows → blur button not shown (isAvailable = false)
7. Performance: Log frame processing times, verify < 15ms average
