import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { ApiError } from '../../src/insales/errors.js';

describe('bounded API diagnostics', () => {
  it('keeps validation fields without including them in public messages or serialization', () => {
    const payload = JSON.stringify({ errors: { email: ['private@example.invalid'] } });
    const error = new ApiError(422, '9/500', '30', undefined, payload);
    expect(error.body).toBe(payload);
    expect(error.data).toEqual(JSON.parse(payload));
    for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
      expect(rendered).not.toContain('private@example.invalid');
    }
  });
  it('caps UTF-8 diagnostics by bytes and tolerates truncated JSON', () => {
    const payload = JSON.stringify({ errors: 'я猫'.repeat(30000) });
    const error = new ApiError(422, undefined, undefined, undefined, payload);
    expect(Buffer.byteLength(error.body)).toBeLessThanOrEqual(65536);
    expect(error.data).toBeUndefined();
  });
});
