import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../logging/logger_service.dart';
import '../media/background_blur_processor.dart';
import '../media/media_service.dart';
import 'preferences_providers.dart';

/// Provider for the logger service.
final loggerServiceProvider = Provider<LoggerService>((ref) {
  // Uses the singleton instance
  return LoggerService.instance;
});

/// Provider for background blur processor.
final backgroundBlurProvider = Provider<BackgroundBlurProcessor>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final processor = BackgroundBlurProcessor();
  processor.initPreferences(prefs);
  ref.onDispose(() => processor.dispose());
  return processor;
});

/// Provider for media service.
final mediaServiceProvider = Provider<MediaService>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final service = MediaService();
  service.initPreferences(prefs);
  ref.onDispose(() => service.dispose());
  return service;
});
