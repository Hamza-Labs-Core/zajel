import 'dart:io';

/// Detected package/distribution format for the running application.
///
/// Determines whether in-app auto-update is supported or whether
/// the user should be redirected to a platform store for updates.
enum PackageFormat {
  /// Loose install from ZIP, DMG, or tarball (supports in-app auto-update).
  loose,

  /// Windows MSIX package (store-managed or sideloaded).
  msix,

  /// macOS App Store build.
  macAppStore,

  /// Linux Snap package (store-managed).
  snap,

  /// Linux Flatpak package (store-managed).
  flatpak,

  /// Linux AppImage (supports auto-update via single file replacement).
  appImage,
}

/// Detects the packaging format of the running application.
///
/// Used to determine whether the in-app auto-updater should be active
/// or whether the user should be redirected to a platform store.
///
/// Detection runs once and caches the result. All detection methods
/// are synchronous (file existence check on macOS, environment variable
/// reads on Linux, path check on Windows).
///
/// For testability, platform values can be injected via the constructor.
/// When no overrides are provided, values come from [Platform].
class UpdatePackageDetector {
  /// Resolved executable path. Defaults to [Platform.resolvedExecutable].
  final String _resolvedExecutablePath;

  /// Environment variables. Defaults to [Platform.environment].
  final Map<String, String> _environment;

  /// File existence checker. Defaults to [File.existsSync].
  final bool Function(String path) _fileExists;

  /// Platform check: is this Windows?
  final bool _isWindows;

  /// Platform check: is this macOS?
  final bool _isMacOS;

  /// Platform check: is this Linux?
  final bool _isLinux;

  PackageFormat? _cachedFormat;

  /// Creates an [UpdatePackageDetector].
  ///
  /// All parameters are optional and default to the actual platform values.
  /// Override them in tests to simulate different environments.
  UpdatePackageDetector({
    String? resolvedExecutablePath,
    Map<String, String>? environment,
    bool Function(String path)? fileExists,
    bool? isWindows,
    bool? isMacOS,
    bool? isLinux,
  })  : _resolvedExecutablePath =
            resolvedExecutablePath ?? Platform.resolvedExecutable,
        _environment = environment ?? Platform.environment,
        _fileExists = fileExists ?? ((path) => File(path).existsSync()),
        _isWindows = isWindows ?? Platform.isWindows,
        _isMacOS = isMacOS ?? Platform.isMacOS,
        _isLinux = isLinux ?? Platform.isLinux;

  /// Detects the package format. Result is cached after the first call.
  PackageFormat detect() {
    if (_cachedFormat != null) return _cachedFormat!;
    _cachedFormat = _detectInternal();
    return _cachedFormat!;
  }

  /// Whether this install supports in-app auto-update.
  ///
  /// Returns true for loose installs and AppImage (both support
  /// file replacement by the updater binary).
  /// Returns false for store-managed packages where the store
  /// handles updates.
  bool supportsAutoUpdate() {
    final format = detect();
    return format == PackageFormat.loose || format == PackageFormat.appImage;
  }

  /// Whether this install is managed by a platform store.
  bool isStoreManaged() {
    final format = detect();
    switch (format) {
      case PackageFormat.msix:
      case PackageFormat.macAppStore:
      case PackageFormat.snap:
      case PackageFormat.flatpak:
        return true;
      case PackageFormat.loose:
      case PackageFormat.appImage:
        return false;
    }
  }

  /// Returns the store name for display in UI.
  /// Returns `null` if not a store-managed install.
  String? storeName() {
    switch (detect()) {
      case PackageFormat.msix:
        return 'Microsoft Store';
      case PackageFormat.macAppStore:
        return 'Mac App Store';
      case PackageFormat.snap:
        return 'Snap Store';
      case PackageFormat.flatpak:
        return 'Flathub';
      case PackageFormat.loose:
      case PackageFormat.appImage:
        return null;
    }
  }

  /// Returns the deep-link URI to open the store listing for Zajel.
  /// Returns `null` if not a store-managed install.
  ///
  /// Store IDs are placeholders that must be replaced with actual
  /// store listing IDs once the app is published to each store.
  String? storeDeepLink() {
    switch (detect()) {
      case PackageFormat.msix:
        // TODO: Replace with actual Microsoft Store Product ID
        return 'ms-windows-store://pdp/?ProductId=ZAJEL_STORE_ID';
      case PackageFormat.macAppStore:
        // TODO: Replace with actual Mac App Store numeric ID
        return 'macappstores://itunes.apple.com/app/zajel/idZAJEL_APP_ID?mt=12';
      case PackageFormat.snap:
        return 'snap://zajel';
      case PackageFormat.flatpak:
        // Flathub has no registered URI scheme; use web URL
        return 'https://flathub.org/apps/com.zajel.Zajel';
      case PackageFormat.loose:
      case PackageFormat.appImage:
        return null;
    }
  }

  /// Returns the fallback web URL for the store listing.
  /// Used when the deep link fails to open.
  /// Returns `null` if not a store-managed install.
  String? storeWebUrl() {
    switch (detect()) {
      case PackageFormat.msix:
        return 'https://apps.microsoft.com/detail/ZAJEL_STORE_ID';
      case PackageFormat.macAppStore:
        return 'https://apps.apple.com/app/zajel/idZAJEL_APP_ID';
      case PackageFormat.snap:
        return 'https://snapcraft.io/zajel';
      case PackageFormat.flatpak:
        return 'https://flathub.org/apps/com.zajel.Zajel';
      case PackageFormat.loose:
      case PackageFormat.appImage:
        return null;
    }
  }

  PackageFormat _detectInternal() {
    if (_isWindows) {
      return _detectWindows();
    } else if (_isMacOS) {
      return _detectMacOS();
    } else if (_isLinux) {
      return _detectLinux();
    }
    // Non-desktop platform (mobile, web) — treat as loose.
    return PackageFormat.loose;
  }

  /// Detect Windows package format.
  ///
  /// MSIX-installed apps run from a virtualized path under
  /// `C:\Program Files\WindowsApps\<PackageFamilyName>\`.
  PackageFormat _detectWindows() {
    if (_resolvedExecutablePath.contains('WindowsApps')) {
      return PackageFormat.msix;
    }
    return PackageFormat.loose;
  }

  /// Detect macOS package format.
  ///
  /// Mac App Store builds contain a receipt file at
  /// `<AppBundle>/Contents/_MASReceipt/receipt`.
  PackageFormat _detectMacOS() {
    final appBundlePath = _findAppBundlePath(_resolvedExecutablePath);
    if (appBundlePath != null) {
      final receiptPath = '$appBundlePath/Contents/_MASReceipt/receipt';
      if (_fileExists(receiptPath)) {
        return PackageFormat.macAppStore;
      }
    }
    return PackageFormat.loose;
  }

  /// Detect Linux package format.
  ///
  /// Checks environment variables set by each packaging system.
  /// Order matters: Snap > Flatpak > AppImage > loose.
  PackageFormat _detectLinux() {
    if (_environment.containsKey('SNAP')) {
      return PackageFormat.snap;
    }
    if (_environment.containsKey('FLATPAK_ID')) {
      return PackageFormat.flatpak;
    }
    if (_environment.containsKey('APPIMAGE')) {
      return PackageFormat.appImage;
    }
    return PackageFormat.loose;
  }

  /// Walk up the path to find the `.app` bundle root.
  /// Returns `null` if no `.app` directory is found.
  static String? _findAppBundlePath(String exePath) {
    final parts = exePath.split('/');
    for (var i = parts.length - 1; i >= 0; i--) {
      if (parts[i].endsWith('.app')) {
        return parts.sublist(0, i + 1).join('/');
      }
    }
    return null;
  }
}
