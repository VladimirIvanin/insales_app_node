import { describe, it, expect } from 'vitest';
import {
  md5,
  installPassword,
  computeToken3,
  constantTimeEqual,
  isValidHexSignature,
  normalizeShop,
} from '../../src/insales/protocol.js';
import vectors from '../fixtures/protocol-vectors.json' with { type: 'json' };

describe('InSales protocol', () => {
  describe('Cross-language vectors', () => {
    const { install, autologin } = vectors;

    it('computes install password correctly', () => {
      const password = md5(install.token, install.secret);
      expect(password).toBe(install.expected_password);
    });

    it('computes token correctly', () => {
      const token = md5(autologin.nonce, install.expected_password);
      expect(token).toBe(autologin.expected_token);
    });

    it('computes token2 correctly', () => {
      const token2 = md5(
        autologin.nonce,
        autologin.email,
        autologin.name,
        autologin.user_id,
        install.expected_password,
      );
      expect(token2).toBe(autologin.expected_token2);
    });

    it('computes token3 correctly', () => {
      const token3 = md5(
        autologin.nonce,
        autologin.email,
        autologin.name,
        autologin.user_id,
        autologin.email_confirmed,
        install.expected_password,
      );
      expect(token3).toBe(autologin.expected_token3);
    });

    it('installPassword wrapper matches', () => {
      expect(installPassword(install.token, install.secret)).toBe(install.expected_password);
    });

    it('computeToken3 wrapper matches', () => {
      const pw = installPassword(install.token, install.secret);
      expect(
        computeToken3(
          autologin.nonce,
          autologin.email,
          autologin.name,
          autologin.user_id,
          autologin.email_confirmed,
          pw,
        ),
      ).toBe(autologin.expected_token3);
    });
  });

  describe('Unicode handling', () => {
    it('handles empty user name', () => {
      const pw = 'test-password';
      const token3 = computeToken3('nonce', 'user@example.com', '', '1', 'true', pw);
      expect(token3).toBe(md5('nonce', 'user@example.com', '', '1', 'true', pw));
    });

    it('handles Russian characters', () => {
      const pw = 'test-password';
      const token3 = computeToken3(
        'nonce',
        'user@example.com',
        'Тестовый пользователь',
        '1',
        'false',
        pw,
      );
      expect(token3).toMatch(/^[a-f0-9]{32}$/);
    });

    it('handles email_confirmed as true/false strings only', () => {
      const pw = 'test-password';
      const tokenTrue = computeToken3('n', 'e', 'u', '1', 'true', pw);
      const tokenFalse = computeToken3('n', 'e', 'u', '1', 'false', pw);
      expect(tokenTrue).not.toBe(tokenFalse);
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal strings', () => {
      expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    });
  });

  describe('isValidHexSignature', () => {
    it('accepts 32 lowercase hex chars', () => {
      expect(isValidHexSignature('abcdef0123456789abcdef0123456789')).toBe(true);
    });

    it('rejects uppercase', () => {
      expect(isValidHexSignature('ABCDEF0123456789abcdef0123456789')).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidHexSignature('abc')).toBe(false);
    });

    it('rejects empty', () => {
      expect(isValidHexSignature('')).toBe(false);
    });
  });

  describe('normalizeShop', () => {
    it('lowercases domain', () => {
      expect(normalizeShop('SHOP.EXAMPLE.COM')).toBe('shop.example.com');
    });

    it('trims whitespace', () => {
      expect(normalizeShop('  shop.example.com  ')).toBe('shop.example.com');
    });

    it('throws on invalid format', () => {
      expect(() => normalizeShop('')).toThrow();
      expect(() => normalizeShop('-bad.com')).toThrow();
    });

    it('accepts domain with port', () => {
      expect(normalizeShop('shop.example.com:8080')).toBe('shop.example.com:8080');
    });
  });
});
