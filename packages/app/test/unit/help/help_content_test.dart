import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/help/help_content.dart';

void main() {
  group('HelpContent', () {
    test('articles list is not empty', () {
      expect(HelpContent.articles, isNotEmpty);
    });

    test('all articles have unique IDs', () {
      final ids = HelpContent.articles.map((a) => a.id).toList();
      expect(ids.toSet().length, equals(ids.length),
          reason: 'All article IDs must be unique');
    });

    test('all articles have non-empty titles', () {
      for (final article in HelpContent.articles) {
        expect(article.title, isNotEmpty,
            reason: 'Article "${article.id}" must have a non-empty title');
      }
    });

    test('all articles have non-empty subtitles', () {
      for (final article in HelpContent.articles) {
        expect(article.subtitle, isNotEmpty,
            reason: 'Article "${article.id}" must have a non-empty subtitle');
      }
    });

    test('all articles have at least one section', () {
      for (final article in HelpContent.articles) {
        expect(article.sections, isNotEmpty,
            reason: 'Article "${article.id}" must have at least one section');
      }
    });

    test('all sections have non-empty body text', () {
      for (final article in HelpContent.articles) {
        for (var i = 0; i < article.sections.length; i++) {
          expect(article.sections[i].body, isNotEmpty,
              reason:
                  'Article "${article.id}" section $i must have non-empty body');
        }
      }
    });

    test('expected articles exist', () {
      final ids = HelpContent.articles.map((a) => a.id).toSet();
      expect(ids, contains('how-it-works'));
      expect(ids, contains('identity'));
      expect(ids, contains('pairing'));
      expect(ids, contains('encryption'));
      expect(ids, contains('data-storage'));
      expect(ids, contains('platform-notes'));
      expect(ids, contains('troubleshooting'));
    });
  });

  group('HelpContent.findArticle', () {
    test('returns article for valid ID', () {
      final article = HelpContent.findArticle('how-it-works');
      expect(article, isNotNull);
      expect(article!.id, equals('how-it-works'));
      expect(article.title, equals('How Zajel Works'));
    });

    test('returns null for unknown ID', () {
      final article = HelpContent.findArticle('nonexistent-article');
      expect(article, isNull);
    });

    test('returns null for empty string ID', () {
      final article = HelpContent.findArticle('');
      expect(article, isNull);
    });

    test('returns correct article for each known ID', () {
      for (final expected in HelpContent.articles) {
        final found = HelpContent.findArticle(expected.id);
        expect(found, isNotNull,
            reason: 'findArticle should find "${expected.id}"');
        expect(found!.id, equals(expected.id));
        expect(found.title, equals(expected.title));
      }
    });
  });

  group('HelpSection', () {
    test('isWarning defaults to false', () {
      const section = HelpSection(body: 'test');
      expect(section.isWarning, isFalse);
    });

    test('isWarning can be set to true', () {
      const section = HelpSection(body: 'test', isWarning: true);
      expect(section.isWarning, isTrue);
    });

    test('header is optional', () {
      const section = HelpSection(body: 'test');
      expect(section.header, isNull);
    });

    test('header can be set', () {
      const section = HelpSection(header: 'Title', body: 'test');
      expect(section.header, equals('Title'));
    });
  });

  group('HelpArticle', () {
    test('can be constructed with required fields', () {
      const article = HelpArticle(
        id: 'test',
        title: 'Test Article',
        subtitle: 'Test subtitle',
        icon: Icons.help,
        sections: [HelpSection(body: 'content')],
      );
      expect(article.id, equals('test'));
      expect(article.title, equals('Test Article'));
      expect(article.subtitle, equals('Test subtitle'));
      expect(article.icon, equals(Icons.help));
      expect(article.sections.length, equals(1));
    });
  });
}
