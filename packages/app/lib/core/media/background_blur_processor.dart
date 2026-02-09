import 'package:shared_preferences/shared_preferences.dart';

import '../logging/logger_service.dart';

/// Manages background blur settings and state.
///
/// The actual video frame processing requires a TFLite selfie segmentation
/// model to be loaded as an asset. This class manages the blur configuration
/// and will apply frame processing when a model is available.
///
/// To enable real-time blur processing:
/// 1. Add `tflite_flutter` to pubspec.yaml
/// 2. Download Google's Selfie Segmentation TFLite model
/// 3. Place it at `assets/models/selfie_segmentation.tflite`
/// 4. Implement frame interception in the WebRTC pipeline
class BackgroundBlurProcessor {
  static const String _tag = 'BackgroundBlurProcessor';
  static const String _enabledKey = 'media_backgroundBlurEnabled';
  static const String _strengthKey = 'media_backgroundBlurStrength';

  SharedPreferences? _prefs;
  bool _enabled = false;
  double _strength = 0.5; // 0.0 to 1.0

  /// Whether background blur is currently enabled.
  bool get enabled => _enabled;

  /// The blur strength (0.0 = light, 1.0 = heavy).
  double get strength => _strength;

  /// Whether the ML model is available for processing.
  /// Returns false until the TFLite model is loaded.
  bool get isModelAvailable => false; // TODO: check for loaded model

  /// Initialize from SharedPreferences.
  void initPreferences(SharedPreferences prefs) {
    _prefs = prefs;
    _enabled = prefs.getBool(_enabledKey) ?? false;
    _strength = prefs.getDouble(_strengthKey) ?? 0.5;
  }

  /// Enable or disable background blur.
  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    await _prefs?.setBool(_enabledKey, enabled);
    logger.info(_tag, 'Background blur ${enabled ? "enabled" : "disabled"}');
  }

  /// Set the blur strength (0.0 to 1.0).
  Future<void> setStrength(double strength) async {
    _strength = strength.clamp(0.0, 1.0);
    await _prefs?.setDouble(_strengthKey, _strength);
    logger.info(_tag, 'Blur strength set to $_strength');
  }

  /// Dispose resources.
  void dispose() {
    logger.info(_tag, 'BackgroundBlurProcessor disposed');
  }
}
