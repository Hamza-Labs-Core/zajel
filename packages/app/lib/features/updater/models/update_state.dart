/// Status of the update lifecycle state machine.
///
/// See plan 09 section 5 for the complete state machine diagram.
enum UpdateStatus {
  /// No update activity. Waiting for next check.
  idle,

  /// Querying version policy and GitHub Releases API for updates.
  checking,

  /// Downloading the update artifact from GitHub Releases.
  downloading,

  /// Verifying SHA-256 checksum of the downloaded artifact.
  verifying,

  /// Download verified and staged. Ready for user confirmation or auto-install.
  ready,

  /// Writing manifest and launching the external updater binary.
  launchingUpdater,

  /// An error occurred during the update process.
  failed,
}

/// Immutable state of the update lifecycle.
///
/// Each state transition produces a new [UpdateState] instance via [copyWith]
/// or one of the named factory constructors.
class UpdateState {
  /// Current status in the update lifecycle.
  final UpdateStatus status;

  /// Download progress as a fraction from 0.0 to 1.0.
  /// Only meaningful when [status] is [UpdateStatus.downloading].
  final double? downloadProgress;

  /// Version string of the available update (e.g., "1.2.0").
  /// Set once an update is discovered.
  final String? availableVersion;

  /// Markdown-formatted release notes from GitHub Releases.
  final String? releaseNotes;

  /// Publication date of the available release.
  final DateTime? releaseDate;

  /// Human-readable error message when [status] is [UpdateStatus.failed].
  final String? errorMessage;

  /// Timestamp of the last successful version check.
  final DateTime? lastChecked;

  const UpdateState({
    this.status = UpdateStatus.idle,
    this.downloadProgress,
    this.availableVersion,
    this.releaseNotes,
    this.releaseDate,
    this.errorMessage,
    this.lastChecked,
  });

  /// Initial idle state with no prior check.
  const UpdateState.initial() : this();

  /// State after a version check finds no update.
  factory UpdateState.upToDate({required DateTime checkedAt}) {
    return UpdateState(
      status: UpdateStatus.idle,
      lastChecked: checkedAt,
    );
  }

  /// State after a version check finds an available update.
  factory UpdateState.updateAvailable({
    required String version,
    String? releaseNotes,
    DateTime? releaseDate,
    required DateTime checkedAt,
  }) {
    return UpdateState(
      status: UpdateStatus.idle,
      availableVersion: version,
      releaseNotes: releaseNotes,
      releaseDate: releaseDate,
      lastChecked: checkedAt,
    );
  }

  /// State while checking for updates.
  factory UpdateState.checking({DateTime? lastChecked}) {
    return UpdateState(
      status: UpdateStatus.checking,
      lastChecked: lastChecked,
    );
  }

  /// State while downloading an update artifact.
  factory UpdateState.downloading({
    required String version,
    required double progress,
    String? releaseNotes,
    DateTime? releaseDate,
  }) {
    return UpdateState(
      status: UpdateStatus.downloading,
      availableVersion: version,
      downloadProgress: progress,
      releaseNotes: releaseNotes,
      releaseDate: releaseDate,
    );
  }

  /// State while verifying the downloaded artifact checksum.
  factory UpdateState.verifying({
    required String version,
    String? releaseNotes,
    DateTime? releaseDate,
  }) {
    return UpdateState(
      status: UpdateStatus.verifying,
      availableVersion: version,
      releaseNotes: releaseNotes,
      releaseDate: releaseDate,
    );
  }

  /// State when the update is downloaded, verified, and ready to install.
  factory UpdateState.ready({
    required String version,
    String? releaseNotes,
    DateTime? releaseDate,
  }) {
    return UpdateState(
      status: UpdateStatus.ready,
      availableVersion: version,
      releaseNotes: releaseNotes,
      releaseDate: releaseDate,
    );
  }

  /// State when the updater binary is being launched.
  factory UpdateState.launchingUpdater({
    required String version,
  }) {
    return UpdateState(
      status: UpdateStatus.launchingUpdater,
      availableVersion: version,
    );
  }

  /// State when an error occurred during the update process.
  factory UpdateState.failed({
    required String errorMessage,
    String? availableVersion,
    DateTime? lastChecked,
  }) {
    return UpdateState(
      status: UpdateStatus.failed,
      errorMessage: errorMessage,
      availableVersion: availableVersion,
      lastChecked: lastChecked,
    );
  }

  /// Creates a copy with the specified fields replaced.
  UpdateState copyWith({
    UpdateStatus? status,
    double? Function()? downloadProgress,
    String? Function()? availableVersion,
    String? Function()? releaseNotes,
    DateTime? Function()? releaseDate,
    String? Function()? errorMessage,
    DateTime? Function()? lastChecked,
  }) {
    return UpdateState(
      status: status ?? this.status,
      downloadProgress:
          downloadProgress != null ? downloadProgress() : this.downloadProgress,
      availableVersion:
          availableVersion != null ? availableVersion() : this.availableVersion,
      releaseNotes: releaseNotes != null ? releaseNotes() : this.releaseNotes,
      releaseDate: releaseDate != null ? releaseDate() : this.releaseDate,
      errorMessage: errorMessage != null ? errorMessage() : this.errorMessage,
      lastChecked: lastChecked != null ? lastChecked() : this.lastChecked,
    );
  }

  @override
  String toString() => 'UpdateState('
      'status=$status'
      '${availableVersion != null ? ', version=$availableVersion' : ''}'
      '${downloadProgress != null ? ', progress=${(downloadProgress! * 100).toStringAsFixed(1)}%' : ''}'
      '${errorMessage != null ? ', error=$errorMessage' : ''}'
      ')';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateState &&
          runtimeType == other.runtimeType &&
          status == other.status &&
          downloadProgress == other.downloadProgress &&
          availableVersion == other.availableVersion &&
          releaseNotes == other.releaseNotes &&
          releaseDate == other.releaseDate &&
          errorMessage == other.errorMessage &&
          lastChecked == other.lastChecked;

  @override
  int get hashCode => Object.hash(
        status,
        downloadProgress,
        availableVersion,
        releaseNotes,
        releaseDate,
        errorMessage,
        lastChecked,
      );
}
