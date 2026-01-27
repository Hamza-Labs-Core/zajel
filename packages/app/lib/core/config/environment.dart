/// Environment configuration for compile-time settings.
///
/// Values are injected via `--dart-define` flags during build:
/// ```bash
/// flutter build apk \
///   --dart-define=BOOTSTRAP_URL=https://qa.example.com \
///   --dart-define=SIGNALING_URL=wss://qa.example.com:8080 \
///   --dart-define=ENV=qa \
///   --dart-define=VERSION=1.0.0
/// ```
library;

/// Environment configuration using compile-time constants.
///
/// These values are baked into the app at build time and cannot be changed
/// at runtime. Use for CI/CD builds targeting different environments.
class Environment {
  Environment._();

  /// Bootstrap/discovery server URL (Cloudflare Workers).
  ///
  /// Used to discover available signaling servers.
  /// Override with `--dart-define=BOOTSTRAP_URL=<url>`
  static const String bootstrapUrl = String.fromEnvironment(
    'BOOTSTRAP_URL',
    defaultValue: '',
  );

  /// Direct signaling server URL (WebSocket).
  ///
  /// If set, bypasses server discovery and connects directly.
  /// Override with `--dart-define=SIGNALING_URL=<url>`
  static const String signalingUrl = String.fromEnvironment(
    'SIGNALING_URL',
    defaultValue: '',
  );

  /// Environment name (production, qa, dev).
  ///
  /// Override with `--dart-define=ENV=<env>`
  static const String env = String.fromEnvironment(
    'ENV',
    defaultValue: 'production',
  );

  /// App version string.
  ///
  /// Override with `--dart-define=VERSION=<version>`
  static const String version = String.fromEnvironment(
    'VERSION',
    defaultValue: '',
  );

  /// Build number for this release.
  ///
  /// Override with `--dart-define=BUILD_NUMBER=<number>`
  static const String buildNumber = String.fromEnvironment(
    'BUILD_NUMBER',
    defaultValue: '',
  );

  /// Whether running in QA environment.
  static bool get isQA => env == 'qa';

  /// Whether running in production environment.
  static bool get isProduction => env == 'production';

  /// Whether running in development environment.
  static bool get isDev => env == 'dev';

  /// Whether a custom bootstrap URL was provided.
  static bool get hasCustomBootstrapUrl => bootstrapUrl.isNotEmpty;

  /// Whether a direct signaling URL was provided (bypasses discovery).
  static bool get hasDirectSignalingUrl => signalingUrl.isNotEmpty;

  /// Full version string including build number.
  static String get fullVersion {
    if (buildNumber.isNotEmpty) {
      return '$version+$buildNumber';
    }
    return version.isNotEmpty ? version : 'dev';
  }
}
