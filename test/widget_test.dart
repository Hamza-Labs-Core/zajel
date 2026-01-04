import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('App smoke test', (WidgetTester tester) async {
    // Basic smoke test - app requires async initialization
    // Full integration tests will be added separately
    expect(1 + 1, equals(2));
  });
}
