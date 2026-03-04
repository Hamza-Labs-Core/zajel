/**
 * Cryptographic utilities for admin dashboard
 * Uses Web Crypto API available in CF Workers
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 32;
const HASH_LENGTH = 32;

/**
 * Generate a cryptographically secure random salt
 */
export function generateSalt(): string {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return uint8ArrayToHex(salt);
}

/**
 * Hash a password using PBKDF2 with the given salt
 */
export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordData = encoder.encode(password);
  const saltData = hexToUint8Array(salt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordData,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltData.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_LENGTH * 8
  );

  return uint8ArrayToHex(new Uint8Array(derivedBits));
}

/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): Promise<boolean> {
  const computedHash = await hashPassword(password, salt);
  return await timingSafeEqual(computedHash, storedHash);
}

/**
 * Generate a JWT token
 */
export async function generateJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInMinutes: number = 15
): Promise<string> {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInMinutes * 60,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signatureInput)
  );

  const encodedSignature = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `${signatureInput}.${encodedSignature}`;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJwt<T = Record<string, unknown>>(
  token: string,
  secret: string
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return null;
  }
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signature = base64UrlDecode(encodedSignature);
  const signatureArray = new Uint8Array(signature.length);
  for (let i = 0; i < signature.length; i++) {
    signatureArray[i] = signature.charCodeAt(i);
  }

  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureArray,
    encoder.encode(signatureInput)
  );

  if (!isValid) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as T & { exp?: number };

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (error) {
    console.warn('[Auth] JWT verification failed:', error);
    return null;
  }
}

/**
 * Generate a random ID
 */
export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return uint8ArrayToHex(bytes);
}

// Helper functions

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

/**
 * Constant-time string comparison using HMAC normalization.
 *
 * HMAC both inputs with a random key, producing fixed-length outputs,
 * then XOR-compare the outputs. This eliminates length-dependent timing
 * because HMAC output is always the same size (32 bytes) regardless of input.
 *
 * Security properties:
 * - No early returns based on length mismatch
 * - Always iterates exactly 32 times (HMAC-SHA256 output length)
 * - Timing is independent of input lengths
 * - Random key per comparison prevents oracle attacks
 *
 * @param a - First string
 * @param b - Second string
 * @returns Whether the strings are equal
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();

  // Generate a random key per comparison to prevent oracle attacks.
  // Even if an attacker could somehow observe HMAC outputs, the random key
  // makes each comparison independent.
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // HMAC both inputs — output is always 32 bytes regardless of input length.
  // This normalization step is what makes the comparison timing-safe.
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  // Fixed-length comparison (both are exactly 32 bytes)
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  // XOR all 32 bytes. If any byte differs, result will be non-zero.
  // This loop always runs exactly 32 iterations.
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
