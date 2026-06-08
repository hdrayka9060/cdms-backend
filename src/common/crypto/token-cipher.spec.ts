import { decryptToken, encryptToken } from './token-cipher';

describe('token-cipher (AES-256-GCM)', () => {
  beforeAll(() => {
    // Deterministic 64-hex-char (32-byte) key for the test run.
    process.env.FACEBOOK_TOKEN_ENC_KEY = 'a'.repeat(64);
  });

  it('round-trips a secret back to the original plaintext', () => {
    const secret = 'EAAB-fake-page-access-token_0123456789';
    expect(decryptToken(encryptToken(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV) for the same input', () => {
    const secret = 'same-input';
    const a = encryptToken(secret);
    const b = encryptToken(secret);
    expect(a).not.toBe(b);
    // ...but both still decrypt to the same plaintext.
    expect(decryptToken(a)).toBe(secret);
    expect(decryptToken(b)).toBe(secret);
  });

  it('treats empty input as empty output (no special-casing for callers)', () => {
    expect(encryptToken('')).toBe('');
    expect(decryptToken('')).toBe('');
  });

  it('throws on a malformed payload', () => {
    expect(() => decryptToken('not-a-valid-payload')).toThrow();
  });

  it('fails to decrypt when the auth tag is tampered with', () => {
    const enc = encryptToken('tamper-me');
    const [iv, , ct] = enc.split('.');
    const forgedTag = Buffer.alloc(16).toString('base64');
    expect(() => decryptToken(`${iv}.${forgedTag}.${ct}`)).toThrow();
  });
});
