import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers/app_providers.dart';
import '../../shared/widgets/warning_box.dart';

/// Onboarding background color — matches the generated illustration backgrounds.
const _onboardingBg = Color(0xFF101030);
const _textColor = Colors.white;
final _mutedColor = Colors.white.withValues(alpha: 0.7);

/// First-launch onboarding screen with a 5-step swipeable tutorial.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _pageController = PageController();
  final _usernameController = TextEditingController();
  int _currentPage = 0;
  bool _usernameValid = false;

  static const _totalPages = 5;

  @override
  void dispose() {
    _pageController.dispose();
    _usernameController.dispose();
    super.dispose();
  }

  Future<void> _completeOnboarding() async {
    final prefs = ref.read(sharedPreferencesProvider);
    final username = _usernameController.text.trim();
    if (username.isNotEmpty) {
      await prefs.setString('username', username);
      ref.read(usernameProvider.notifier).state = username;
    }
    await prefs.setBool('hasSeenOnboarding', true);
    ref.read(hasSeenOnboardingProvider.notifier).state = true;
    if (mounted) {
      context.go('/');
    }
  }

  void _nextPage() {
    if (_currentPage == 1 && !_usernameValid) return;
    FocusScope.of(context).unfocus();

    if (_currentPage < _totalPages - 1) {
      _pageController.nextPage(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    } else {
      _completeOnboarding();
    }
  }

  void _skip() {
    final prefs = ref.read(sharedPreferencesProvider);
    prefs.setString('username', 'Anonymous');
    ref.read(usernameProvider.notifier).state = 'Anonymous';
    _completeOnboarding();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _onboardingBg,
      body: SafeArea(
        child: Column(
          children: [
            // Skip button
            Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.only(top: 8, right: 16),
                child: TextButton(
                  onPressed: _skip,
                  child: Text(
                    'Skip',
                    style: TextStyle(color: _mutedColor),
                  ),
                ),
              ),
            ),
            // Page content
            Expanded(
              child: PageView(
                controller: _pageController,
                onPageChanged: (page) {
                  FocusScope.of(context).unfocus();
                  setState(() => _currentPage = page);
                },
                children: [
                  _buildWelcomePage(),
                  _buildUsernamePage(),
                  _buildIdentityPage(),
                  _buildConnectPage(),
                  _buildGetStartedPage(),
                ],
              ),
            ),
            // Dots indicator and navigation
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: List.generate(
                      _totalPages,
                      (index) => Container(
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        width: index == _currentPage ? 24 : 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: index == _currentPage
                              ? Colors.white
                              : Colors.white.withValues(alpha: 0.25),
                          borderRadius: BorderRadius.circular(4),
                        ),
                      ),
                    ),
                  ),
                  ElevatedButton(
                    onPressed: (_currentPage == 1 && !_usernameValid)
                        ? null
                        : _nextPage,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: _onboardingBg,
                      disabledBackgroundColor:
                          Colors.white.withValues(alpha: 0.15),
                      disabledForegroundColor:
                          Colors.white.withValues(alpha: 0.4),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 32,
                        vertical: 14,
                      ),
                    ),
                    child: Text(
                      _currentPage == _totalPages - 1 ? 'Get Started' : 'Next',
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Builds an image page with illustration on top, title + subtitle below.
  Widget _buildImagePage({
    required String assetPath,
    required String title,
    required String subtitle,
  }) {
    return Column(
      children: [
        Expanded(
          flex: 3,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
            child: Image.asset(
              assetPath,
              fit: BoxFit.contain,
            ),
          ),
        ),
        Expanded(
          flex: 2,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.bold,
                    color: _textColor,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                Text(
                  subtitle,
                  style: TextStyle(
                    fontSize: 16,
                    color: _mutedColor,
                    height: 1.5,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildWelcomePage() {
    return _buildImagePage(
      assetPath: 'assets/images/onboarding_private.png',
      title: 'Welcome to Zajel',
      subtitle: 'Private peer-to-peer messaging.\n'
          'No accounts. No servers. Just you and your contacts.',
    );
  }

  Widget _buildUsernamePage() {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        children: [
          const SizedBox(height: 48),
          const Icon(Icons.person, size: 80, color: Colors.white70),
          const SizedBox(height: 32),
          const Text(
            'Choose a Username',
            style: TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.bold,
              color: _textColor,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Text(
            'This is how others will see you. '
            'A unique tag will be added based on your encryption key.',
            style: TextStyle(fontSize: 16, color: _mutedColor, height: 1.5),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          TextField(
            controller: _usernameController,
            autofocus: true,
            maxLength: 32,
            style: const TextStyle(color: Colors.white),
            decoration: InputDecoration(
              hintText: 'Enter your username',
              hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.4)),
              filled: true,
              fillColor: Colors.white.withValues(alpha: 0.1),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide:
                    BorderSide(color: Colors.white.withValues(alpha: 0.3)),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide:
                    BorderSide(color: Colors.white.withValues(alpha: 0.3)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Colors.white),
              ),
              counterText: '',
            ),
            onChanged: (value) {
              final trimmed = value.trim();
              setState(() {
                _usernameValid = trimmed.isNotEmpty &&
                    trimmed.length <= 32 &&
                    !trimmed.contains('#');
              });
            },
          ),
          const SizedBox(height: 8),
          Text(
            'Max 32 characters. The # character is not allowed.',
            style: TextStyle(
              fontSize: 12,
              color: Colors.white.withValues(alpha: 0.5),
            ),
          ),
          const SizedBox(height: 48),
        ],
      ),
    );
  }

  Widget _buildIdentityPage() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.fingerprint, size: 80, color: Colors.white70),
          const SizedBox(height: 32),
          const Text(
            'Your Identity',
            style: TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.bold,
              color: _textColor,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Text(
            'Your identity was just created as a cryptographic keypair '
            'on this device. It exists nowhere else.',
            style: TextStyle(fontSize: 16, color: _mutedColor, height: 1.5),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          const WarningBox(
            body: 'If you uninstall this app, your identity is permanently '
                'lost. There is no recovery mechanism. All your contacts '
                'will need to re-pair with you.',
          ),
        ],
      ),
    );
  }

  Widget _buildConnectPage() {
    return _buildImagePage(
      assetPath: 'assets/images/onboarding_p2p.png',
      title: 'Direct P2P Connection',
      subtitle: 'Share your pairing code or scan a QR code. '
          'Both devices must be online. Once paired, '
          'they reconnect automatically.',
    );
  }

  Widget _buildGetStartedPage() {
    return _buildImagePage(
      assetPath: 'assets/images/onboarding_no_account.png',
      title: 'No Account Required',
      subtitle: 'Tap "Get Started" to begin. Add your first peer '
          'from the Connect screen.',
    );
  }
}
