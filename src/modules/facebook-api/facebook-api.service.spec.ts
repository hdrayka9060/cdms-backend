import { createHmac } from 'crypto';
import { FacebookApiService } from './facebook-api.service';

/** Build a service with a fake ConfigService, then run onModuleInit so the
 *  dev-mode / real-mode detection executes (matches how Nest would init it). */
function makeService(overrides: Record<string, string> = {}): FacebookApiService {
  const cfg: Record<string, string> = {
    FACEBOOK_APP_ID: 'fb-app-id',
    FACEBOOK_APP_SECRET: 'fb-app-secret',
    FACEBOOK_CONFIG_ID: 'fb-config-id',
    FACEBOOK_API_VERSION: 'v20.0',
    FACEBOOK_REDIRECT_URI: 'http://localhost:8080/facebook/connect/callback',
    FACEBOOK_VERIFY_TOKEN: 'verify-token-123',
    ...overrides,
  };
  const fakeConfig = { get: (k: string) => cfg[k] } as any;
  const svc = new FacebookApiService(fakeConfig);
  svc.onModuleInit();
  return svc;
}

describe('FacebookApiService — dev-mode detection', () => {
  it('is real-mode when creds look real', () => {
    expect(makeService().devMode).toBe(false);
  });

  it('falls back to dev-mode when creds are blank or placeholders', () => {
    expect(makeService({ FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' }).devMode).toBe(true);
    expect(makeService({ FACEBOOK_APP_ID: 'your_facebook_app_id' }).devMode).toBe(true);
  });

  it('mints a deterministic mock Page in dev-mode (no network)', async () => {
    const svc = makeService({ FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' });
    const conns = await svc.exchangeCodeForConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].pageId).toBe('dev-page-1');
    expect(conns[0].accessToken).toBeTruthy();
  });
});

describe('FacebookApiService — webhook security', () => {
  const secret = 'fb-app-secret';
  const sign = (body: string) =>
    'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts a correctly-signed payload', () => {
    const svc = makeService();
    const body = JSON.stringify({ object: 'page', entry: [] });
    expect(svc.verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const svc = makeService();
    const body = JSON.stringify({ object: 'page' });
    expect(svc.verifyWebhookSignature(body, sign(body + 'x'))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const svc = makeService();
    expect(svc.verifyWebhookSignature('{}', undefined)).toBe(false);
  });

  it('rejects when no app secret is configured (dev-mode)', () => {
    const svc = makeService({ FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' });
    expect(svc.devMode).toBe(true);
    const body = '{}';
    expect(svc.verifyWebhookSignature(body, sign(body))).toBe(false);
  });

  it('validates the GET challenge handshake against the verify token', () => {
    const svc = makeService();
    expect(svc.verifyWebhookChallenge('subscribe', 'verify-token-123')).toBe(true);
    expect(svc.verifyWebhookChallenge('subscribe', 'wrong')).toBe(false);
    expect(svc.verifyWebhookChallenge('unsubscribe', 'verify-token-123')).toBe(false);
  });
});

describe('FacebookApiService — buildAuthUrl', () => {
  it('returns a Facebook dialog URL in real-mode and null in dev-mode', () => {
    const real = makeService();
    const url = real.buildAuthUrl('state-abc');
    expect(url).toContain('facebook.com');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('config_id=fb-config-id');

    const dev = makeService({ FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' });
    expect(dev.buildAuthUrl('state-abc')).toBeNull();
  });
});
