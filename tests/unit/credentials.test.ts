import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/storage/credentials.js';

describe('Credential encryption', () => {
  const key = Buffer.from(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'hex',
  );

  it('encrypts and decrypts a password', () => {
    const password = 'test-password-123';
    const aad = 'shop.example:42:store';
    const encrypted = encrypt(password, key, aad);
    expect(encrypted.data).toBeTruthy();
    expect(encrypted.data.length).toBeGreaterThan(0);

    const decrypted = decrypt(encrypted, key, aad);
    expect(decrypted).toBe(password);
  });

  it('produces different ciphertexts for same input (unique IV)', () => {
    const aad = 'shop.example:42:store';
    const e1 = encrypt('same-password', key, aad);
    const e2 = encrypt('same-password', key, aad);
    expect(e1.data).not.toBe(e2.data);
  });

  it('fails with wrong key', () => {
    const wrongKey = Buffer.from(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'hex',
    );
    const aad = 'shop.example:42:store';
    const encrypted = encrypt('test-password', key, aad);
    expect(() => decrypt(encrypted, wrongKey, aad)).toThrow();
  });

  it('fails with wrong AAD', () => {
    const aad1 = 'shop.example:42:store';
    const aad2 = 'shop.evil:43:store';
    const encrypted = encrypt('test-password', key, aad1);
    expect(() => decrypt(encrypted, key, aad2)).toThrow();
  });

  it('fails with corrupted ciphertext', () => {
    const aad = 'shop.example:42:store';
    const encrypted = encrypt('test-password', key, aad);
    // Corrupt last few chars
    const corrupted = encrypted.data.slice(0, -4) + 'dead';
    expect(() => decrypt({ data: corrupted }, key, aad)).toThrow();
  });

  it('rejects empty blob', () => {
    expect(() => decrypt({ data: '' }, key, 'test')).toThrow();
  });

  it('rejects too-short blob', () => {
    expect(() => decrypt({ data: 'abcd' }, key, 'test')).toThrow();
  });
});
