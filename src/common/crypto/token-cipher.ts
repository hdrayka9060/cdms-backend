import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Symmetric (reversible) encryption for secrets we must be able to read back —
 * specifically Facebook Page access tokens, which we need in plaintext to call
 * the Graph API. This is deliberately NOT bcrypt: bcrypt is a one-way hash
 * (right for passwords / refresh tokens we only ever *compare*), whereas a
 * stored OAuth token has to be decryptable at call time.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — tampering is detected on
 * decrypt). Output format is a single string `base64(iv).base64(tag).base64(ct)`
 * so it drops straight into a Mongoose `string` field.
 *
 * Key resolution (`FACEBOOK_TOKEN_ENC_KEY`):
 *  • a 64-char hex string → used directly as the 32-byte AES-256 key (the
 *    production shape; generate with
 *    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
 *  • any other non-empty string → sha256'd to 32 bytes (lenient).
 *  • empty / unset → sha256 of a fixed dev constant. Acceptable ONLY because in
 *    dev-mode the tokens we store are mock values; production MUST set a real
 *    64-hex-char key. Mirrors the MailService/GoogleMeet "dev-mode still works"
 *    philosophy.
 */
function resolveKey(): Buffer {
  const raw = process.env.FACEBOOK_TOKEN_ENC_KEY ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256')
    .update(raw || 'cdms-facebook-dev-key')
    .digest();
}

const IV_BYTES = 12; // GCM standard nonce length

/**
 * Encrypt a plaintext secret. Returns '' for empty input so callers can store
 * "no token" without a special case. A fresh random IV per call means the same
 * plaintext encrypts to a different string every time.
 */
export function encryptToken(plain: string): string {
  if (!plain) return '';
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/**
 * Decrypt a string produced by {@link encryptToken}. Returns '' for empty
 * input. Throws if the payload is malformed or the auth tag fails (tampering /
 * wrong key).
 */
export function decryptToken(enc: string): string {
  if (!enc) return '';
  const parts = enc.split('.');
  if (parts.length !== 3) {
    throw new Error('decryptToken: malformed payload (expected iv.tag.ct)');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = resolveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}
