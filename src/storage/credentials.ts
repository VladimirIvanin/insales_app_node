import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { StorageError } from '../insales/errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const VERSION = Buffer.from([0x01]); // format version byte

export interface EncryptedBlob {
  /** Version byte + IV + ciphertext + auth tag, all as hex */
  data: string;
}

/**
 * Encrypt a plaintext password using AES-256-GCM.
 * AAD binds the ciphertext to a specific domain and purpose.
 */
export function encrypt(plaintext: string, key: Buffer, aad: string): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Set AAD
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: version(1) + iv(16) + tag(16) + ciphertext
  const blob = Buffer.concat([VERSION, iv, tag, encrypted]);
  return { data: blob.toString('hex') };
}

/**
 * Decrypt a password that was encrypted with encrypt().
 * Verifies the AAD binding.
 */
export function decrypt(blob: EncryptedBlob, key: Buffer, aad: string): string {
  const raw = Buffer.from(blob.data, 'hex');

  if (raw.length < 1 + IV_LENGTH + TAG_LENGTH + 1) {
    throw new StorageError('Encrypted blob is too short or corrupted');
  }

  const version = raw[0];
  if (version !== 0x01) {
    throw new StorageError(`Unknown encryption format version: ${version}`);
  }

  const iv = raw.subarray(1, 1 + IV_LENGTH);
  const tag = raw.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(1 + IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(aad, 'utf8'));

  try {
    const decrypted = decipher.update(ciphertext) + decipher.final('utf8');
    return decrypted;
  } catch (err) {
    throw new StorageError('Failed to decrypt credential: invalid key or corrupted data');
  }
}

/**
 * Generate a cryptographically random string (URL-safe base64).
 */
export function randomId(bytes: number = 32): string {
  return randomBytes(bytes).toString('base64url');
}