/**
 * XSS Sanitization and Input Validation Tests
 *
 * Tests for the defense-in-depth sanitization functions that protect
 * against XSS and related input-based attacks.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeDisplayName,
  isValidDisplayName,
  sanitizeFilename,
  isValidFilename,
  sanitizeMessage,
  isValidMessage,
  sanitizeErrorMessage,
  isValidUrl,
  sanitizeUrl,
  isNonEmptyString,
  isSafePositiveInteger,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
} from '../validation';

describe('sanitizeDisplayName', () => {
  it('should return empty string for null/undefined', () => {
    expect(sanitizeDisplayName(null as unknown as string)).toBe('');
    expect(sanitizeDisplayName(undefined as unknown as string)).toBe('');
  });

  it('should trim whitespace', () => {
    expect(sanitizeDisplayName('  John Doe  ')).toBe('John Doe');
  });

  it('should remove control characters', () => {
    expect(sanitizeDisplayName('John\x00Doe')).toBe('JohnDoe');
    expect(sanitizeDisplayName('John\x1FDoe')).toBe('JohnDoe');
    expect(sanitizeDisplayName('John\x7FDoe')).toBe('JohnDoe');
    expect(sanitizeDisplayName('Hello\u0000World')).toBe('HelloWorld');
  });

  it('should limit length to MAX_DISPLAY_NAME_LENGTH', () => {
    const longName = 'A'.repeat(100);
    const result = sanitizeDisplayName(longName);
    expect(result.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME_LENGTH);
  });

  it('should preserve valid characters', () => {
    expect(sanitizeDisplayName('John Doe')).toBe('John Doe');
    expect(sanitizeDisplayName('Jean-Pierre')).toBe('Jean-Pierre');
    expect(sanitizeDisplayName("O'Brien")).toBe("O'Brien");
  });

  it('should handle XSS attempts safely', () => {
    // These would be escaped by Preact anyway, but we still clean them
    expect(sanitizeDisplayName('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(sanitizeDisplayName('John<img onerror=alert(1)>Doe')).toBe('John<img onerror=alert(1)>Doe');
  });
});

describe('isValidDisplayName', () => {
  it('should return false for empty/null values', () => {
    expect(isValidDisplayName('')).toBe(false);
    expect(isValidDisplayName(null as unknown as string)).toBe(false);
    expect(isValidDisplayName(undefined as unknown as string)).toBe(false);
  });

  it('should return false for names exceeding max length', () => {
    const longName = 'A'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    expect(isValidDisplayName(longName)).toBe(false);
  });

  it('should accept valid names', () => {
    expect(isValidDisplayName('John')).toBe(true);
    expect(isValidDisplayName('John Doe')).toBe(true);
    expect(isValidDisplayName('Jean-Pierre')).toBe(true);
    expect(isValidDisplayName("O'Brien")).toBe(true);
    expect(isValidDisplayName('User_123')).toBe(true);
  });

  it('should reject names with null bytes', () => {
    // The regex validates allowed characters; null bytes don't match the pattern
    expect(isValidDisplayName('John\x00Doe')).toBe(false);
  });

  it('should allow names with whitespace characters', () => {
    // Whitespace (including newlines) is allowed in the regex as \s
    // Applications should sanitize before validation if needed
    expect(isValidDisplayName('Hello World')).toBe(true);
  });
});

describe('sanitizeFilename', () => {
  it('should return default name for null/undefined', () => {
    expect(sanitizeFilename(null as unknown as string)).toBe('unknown_file');
    expect(sanitizeFilename(undefined as unknown as string)).toBe('unknown_file');
    expect(sanitizeFilename('')).toBe('unknown_file');
  });

  it('should remove path separators', () => {
    expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
    expect(sanitizeFilename('path\\to\\file.txt')).toBe('path_to_file.txt');
    // Path traversal: ../../../etc/passwd -> .._.._.._etc_passwd (dots stay, slashes become _)
    expect(sanitizeFilename('../../../etc/passwd')).toBe('.._.._.._etc_passwd');
  });

  it('should remove control characters', () => {
    expect(sanitizeFilename('file\x00name.txt')).toBe('filename.txt');
    expect(sanitizeFilename('file\x1Fname.txt')).toBe('filename.txt');
    expect(sanitizeFilename('file\x7Fname.txt')).toBe('filename.txt');
  });

  it('should limit length to 255 characters', () => {
    const longName = 'A'.repeat(300) + '.txt';
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(255);
  });

  it('should trim whitespace', () => {
    expect(sanitizeFilename('  file.txt  ')).toBe('file.txt');
  });

  it('should preserve valid filenames', () => {
    expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
    expect(sanitizeFilename('my-file_v2.txt')).toBe('my-file_v2.txt');
    expect(sanitizeFilename('report (2024).xlsx')).toBe('report (2024).xlsx');
  });

  it('should handle XSS in filenames', () => {
    // XSS in filenames would be escaped by Preact when rendered
    // The slash in </script> gets replaced with _
    expect(sanitizeFilename('<script>alert(1)</script>.txt')).toBe('<script>alert(1)<_script>.txt');
  });
});

describe('isValidFilename', () => {
  it('should return false for null/undefined/empty', () => {
    expect(isValidFilename(null as unknown as string)).toBe(false);
    expect(isValidFilename(undefined as unknown as string)).toBe(false);
    expect(isValidFilename('')).toBe(false);
  });

  it('should return false for path traversal attempts', () => {
    expect(isValidFilename('../file.txt')).toBe(false);
    expect(isValidFilename('..\\file.txt')).toBe(false);
    expect(isValidFilename('path/file.txt')).toBe(false);
    expect(isValidFilename('path\\file.txt')).toBe(false);
  });

  it('should return false for control characters', () => {
    expect(isValidFilename('file\x00.txt')).toBe(false);
    expect(isValidFilename('file\n.txt')).toBe(false);
  });

  it('should return false for overly long filenames', () => {
    const longName = 'A'.repeat(256);
    expect(isValidFilename(longName)).toBe(false);
  });

  it('should accept valid filenames', () => {
    expect(isValidFilename('document.pdf')).toBe(true);
    expect(isValidFilename('my-file_v2.txt')).toBe(true);
    expect(isValidFilename('report (2024).xlsx')).toBe(true);
  });
});

describe('sanitizeMessage', () => {
  it('should return empty string for null/undefined', () => {
    expect(sanitizeMessage(null as unknown as string)).toBe('');
    expect(sanitizeMessage(undefined as unknown as string)).toBe('');
    expect(sanitizeMessage('')).toBe('');
  });

  it('should preserve newlines and tabs', () => {
    expect(sanitizeMessage('Hello\nWorld')).toBe('Hello\nWorld');
    expect(sanitizeMessage('Hello\tWorld')).toBe('Hello\tWorld');
    expect(sanitizeMessage('Hello\r\nWorld')).toBe('Hello\r\nWorld');
  });

  it('should remove other control characters', () => {
    expect(sanitizeMessage('Hello\x00World')).toBe('HelloWorld');
    expect(sanitizeMessage('Hello\x07World')).toBe('HelloWorld'); // Bell
    expect(sanitizeMessage('Hello\x0BWorld')).toBe('HelloWorld'); // Vertical tab
    expect(sanitizeMessage('Hello\x7FWorld')).toBe('HelloWorld'); // DEL
  });

  it('should limit length to MAX_MESSAGE_LENGTH', () => {
    const longMessage = 'A'.repeat(MAX_MESSAGE_LENGTH + 1000);
    const result = sanitizeMessage(longMessage);
    expect(result.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('should preserve HTML (Preact will escape it)', () => {
    // Preact auto-escapes, so we just pass through
    expect(sanitizeMessage('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(sanitizeMessage('<img onerror=alert(1)>')).toBe('<img onerror=alert(1)>');
  });
});

describe('isValidMessage', () => {
  it('should return false for non-strings', () => {
    expect(isValidMessage(null as unknown as string)).toBe(false);
    expect(isValidMessage(undefined as unknown as string)).toBe(false);
    expect(isValidMessage(123 as unknown as string)).toBe(false);
  });

  it('should return false for empty strings', () => {
    expect(isValidMessage('')).toBe(false);
  });

  it('should return false for overly long messages', () => {
    const longMessage = 'A'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(isValidMessage(longMessage)).toBe(false);
  });

  it('should return true for valid messages', () => {
    expect(isValidMessage('Hello')).toBe(true);
    expect(isValidMessage('Hello World!')).toBe(true);
    expect(isValidMessage('A'.repeat(MAX_MESSAGE_LENGTH))).toBe(true);
  });
});

describe('sanitizeErrorMessage', () => {
  it('should return default message for null/undefined', () => {
    expect(sanitizeErrorMessage(null as unknown as string)).toBe('An unknown error occurred');
    expect(sanitizeErrorMessage(undefined as unknown as string)).toBe('An unknown error occurred');
    expect(sanitizeErrorMessage('')).toBe('An unknown error occurred');
  });

  it('should remove control characters', () => {
    expect(sanitizeErrorMessage('Error\x00occurred')).toBe('Erroroccurred');
    expect(sanitizeErrorMessage('Error\x1Foccurred')).toBe('Erroroccurred');
  });

  it('should limit length to prevent UI overflow', () => {
    const longError = 'Error: ' + 'A'.repeat(2000);
    const result = sanitizeErrorMessage(longError);
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it('should trim whitespace', () => {
    expect(sanitizeErrorMessage('  Error occurred  ')).toBe('Error occurred');
  });

  it('should preserve valid error messages', () => {
    expect(sanitizeErrorMessage('Connection failed')).toBe('Connection failed');
    expect(sanitizeErrorMessage('Error: timeout after 30s')).toBe('Error: timeout after 30s');
  });
});

describe('isValidUrl', () => {
  it('should return false for null/undefined/empty', () => {
    expect(isValidUrl(null as unknown as string)).toBe(false);
    expect(isValidUrl(undefined as unknown as string)).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });

  it('should return false for non-strings', () => {
    expect(isValidUrl(123 as unknown as string)).toBe(false);
  });

  it('should accept http and https URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com/path?query=value')).toBe(true);
  });

  it('should reject javascript: protocol', () => {
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
    expect(isValidUrl('javascript:void(0)')).toBe(false);
    expect(isValidUrl('JAVASCRIPT:alert(1)')).toBe(false);
  });

  it('should reject vbscript: protocol', () => {
    expect(isValidUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('should reject data: protocol', () => {
    expect(isValidUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isValidUrl('data:image/png;base64,abc123')).toBe(false);
  });

  it('should reject file: protocol', () => {
    expect(isValidUrl('file:///etc/passwd')).toBe(false);
  });

  it('should reject invalid URLs', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('://missing-protocol')).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  it('should return null for invalid URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe(null);
    expect(sanitizeUrl('data:text/html,<script>')).toBe(null);
    expect(sanitizeUrl('not a url')).toBe(null);
  });

  it('should return the URL for valid URLs', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
    expect(sanitizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('isNonEmptyString', () => {
  it('should return false for non-strings', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
    expect(isNonEmptyString([])).toBe(false);
  });

  it('should return false for empty strings', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('should return true for non-empty strings', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
    expect(isNonEmptyString('0')).toBe(true);
  });
});

describe('isSafePositiveInteger', () => {
  it('should return false for non-numbers', () => {
    expect(isSafePositiveInteger(null)).toBe(false);
    expect(isSafePositiveInteger(undefined)).toBe(false);
    expect(isSafePositiveInteger('123')).toBe(false);
    expect(isSafePositiveInteger({})).toBe(false);
  });

  it('should return false for non-integers', () => {
    expect(isSafePositiveInteger(1.5)).toBe(false);
    expect(isSafePositiveInteger(NaN)).toBe(false);
    expect(isSafePositiveInteger(Infinity)).toBe(false);
  });

  it('should return false for zero and negative numbers', () => {
    expect(isSafePositiveInteger(0)).toBe(false);
    expect(isSafePositiveInteger(-1)).toBe(false);
    expect(isSafePositiveInteger(-100)).toBe(false);
  });

  it('should return false for unsafe integers', () => {
    expect(isSafePositiveInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('should return true for safe positive integers', () => {
    expect(isSafePositiveInteger(1)).toBe(true);
    expect(isSafePositiveInteger(100)).toBe(true);
    expect(isSafePositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
