import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdAccountSummary,
  AdInsightRow,
  AdsOAuthResult,
  FetchInsightsOptions,
  mockInsightRows,
} from './ads-api.types';

/**
 * Read-only wrapper around the Google Ads API (GAQL reporting). Mirrors
 * FacebookApiService: `@Global` (via AdsApiModule), ConfigService-driven
 * dev-mode fallback, all network calls behind one service.
 *
 * Auth model (per PROJECT_MEMORY single-tenant + the Google Meet single-account
 * pattern): OAuth2 (client id/secret) → per-account refresh token (minted in
 * the in-app connect flow), plus an app-level developer token and an optional
 * Manager (MCC) `login-customer-id`. Reporting is via GAQL `googleAds:search`.
 *
 * NOTE: a Google Ads developer token starts with TEST-account access only;
 * querying a real account before Basic Access is approved returns
 * DEVELOPER_TOKEN_NOT_APPROVED — which `fetchInsights` surfaces verbatim so the
 * UI can explain the gate.
 */
@Injectable()
export class GoogleAdsApiService implements OnModuleInit {
  private readonly logger = new Logger(GoogleAdsApiService.name);

  private clientId = '';
  private clientSecret = '';
  private developerToken = '';
  private loginCustomerId = '';
  private redirectUri = '';
  // Google Ads API versions sunset ~yearly; a stale version makes every call
  // 404 (the URL path no longer exists). Bump this if calls start 404ing.
  private apiVersion = 'v21';
  private _devMode = true;

  /** Single read-only reporting scope. */
  static readonly SCOPE = 'https://www.googleapis.com/auth/adwords';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.clientId = this.config.get<string>('GOOGLE_ADS_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET') ?? '';
    this.developerToken = this.config.get<string>('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '';
    this.loginCustomerId = (this.config.get<string>('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(
      /-/g,
      '',
    );
    this.redirectUri = this.config.get<string>('GOOGLE_ADS_REDIRECT_URI') ?? '';
    this.apiVersion = this.config.get<string>('GOOGLE_ADS_API_VERSION') || 'v21';

    const credsLookReal =
      !!this.clientId &&
      !!this.clientSecret &&
      !!this.developerToken &&
      this.clientId !== 'your_google_ads_client_id' &&
      this.clientSecret !== 'your_google_ads_client_secret' &&
      this.developerToken !== 'your_google_ads_developer_token';

    if (!credsLookReal) {
      this._devMode = true;
      this.logger.warn(
        'GOOGLE_ADS_* not fully configured — Google Ads API running in dev mode (mock analytics; no real API calls).',
      );
      return;
    }

    this._devMode = false;
    this.logger.log(
      `📈 Google Ads API ready (${this.apiVersion}, mcc=${this.loginCustomerId || 'none'})`,
    );
  }

  get devMode(): boolean {
    return this._devMode;
  }

  /** Configured Manager (MCC) id from env, used as the default login-customer-id. */
  get configuredLoginCustomerId(): string {
    return this.loginCustomerId;
  }

  /** Build the Google consent URL. `access_type=offline` + `prompt=consent`
   *  guarantee a refresh token. Returns null in dev-mode. */
  buildAuthUrl(state: string): string | null {
    if (this._devMode) return null;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GoogleAdsApiService.SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /** Exchange an OAuth code for a refresh token. Dev-mode returns mock tokens. */
  async exchangeCodeForTokens(code?: string): Promise<AdsOAuthResult> {
    if (this._devMode) {
      return { accessToken: 'dev-google-access-token', refreshToken: 'dev-google-refresh-token' };
    }
    if (!code) throw new BadRequestException('Missing Google OAuth authorization code');

    const json = await this.oauth({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    if (!json.refresh_token) {
      throw new ServiceUnavailableException(
        'Google did not return a refresh token. Re-consent (the connect flow uses access_type=offline & prompt=consent).',
      );
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
    };
  }

  /** Mint a short-lived access token from a stored refresh token. */
  async getAccessToken(refreshToken: string): Promise<string> {
    const json = await this.oauth({
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    });
    return json.access_token;
  }

  /** Ad accounts the connected user can access (resource names → ids). */
  async listAccessibleCustomers(refreshToken: string): Promise<AdAccountSummary[]> {
    if (this._devMode) {
      return [{ accountId: '6765726290', accountName: 'Dev Google Ads Account', currency: 'USD' }];
    }
    const accessToken = await this.getAccessToken(refreshToken);
    const res = await fetch(
      `https://googleads.googleapis.com/${this.apiVersion}/customers:listAccessibleCustomers`,
      { headers: { 'developer-token': this.developerToken, Authorization: `Bearer ${accessToken}` } },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) throw new ServiceUnavailableException(this.gErr(res.status, json));
    const names: string[] = Array.isArray(json.resourceNames) ? json.resourceNames : [];
    return names.map((n) => {
      const id = String(n).replace('customers/', '');
      return { accountId: id, accountName: `Google Ads ${id}`, currency: '' };
    });
  }

  /** Daily per-campaign metrics via GAQL. Dev-mode returns deterministic mocks. */
  async fetchInsights(opts: FetchInsightsOptions): Promise<AdInsightRow[]> {
    if (this._devMode) return mockInsightRows('google', opts.startDate, opts.endDate);
    if (!opts.refreshToken) throw new BadRequestException('Missing Google refresh token');
    if (!opts.accountId) throw new BadRequestException('Missing Google customer id');

    const accessToken = await this.getAccessToken(opts.refreshToken);
    const customerId = opts.accountId.replace(/-/g, '');
    const query =
      'SELECT segments.date, campaign.id, campaign.name, metrics.impressions, ' +
      'metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
      `FROM campaign WHERE segments.date BETWEEN '${opts.startDate}' AND '${opts.endDate}'`;

    const headers: Record<string, string> = {
      'developer-token': this.developerToken,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const mcc = (opts.loginCustomerId || this.loginCustomerId).replace(/-/g, '');
    if (mcc) headers['login-customer-id'] = mcc;

    const res = await fetch(
      `https://googleads.googleapis.com/${this.apiVersion}/customers/${customerId}/googleAds:search`,
      { method: 'POST', headers, body: JSON.stringify({ query, pageSize: 10000 }) },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) throw new ServiceUnavailableException(this.gErr(res.status, json));

    const results: any[] = Array.isArray(json.results) ? json.results : [];
    return results.map((r) => ({
      date: r?.segments?.date ?? '',
      campaignId: String(r?.campaign?.id ?? ''),
      campaignName: r?.campaign?.name ?? '',
      spend: Number(r?.metrics?.costMicros ?? 0) / 1_000_000,
      impressions: Number(r?.metrics?.impressions ?? 0),
      clicks: Number(r?.metrics?.clicks ?? 0),
      conversions: Number(r?.metrics?.conversions ?? 0),
      conversionValue: Number(r?.metrics?.conversionsValue ?? 0),
    }));
  }

  private async oauth(params: Record<string, string>): Promise<any> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      // `invalid_grant` = the stored refresh token is expired/revoked (the #1
      // cause of Google Ads "stopped working"). Google returns a useless
      // "Bad Request" description for it, so we replace it with an actionable
      // message. Testing-mode OAuth consent screens expire the token after 7
      // days — publishing the consent screen is the permanent fix.
      if (json?.error === 'invalid_grant') {
        throw new ServiceUnavailableException(
          'Google Ads authorization expired — reconnect the account in Marketing → Connections. To stop it expiring, publish the OAuth consent screen to Production (Testing-mode tokens die after 7 days).',
        );
      }
      throw new ServiceUnavailableException(
        `Google OAuth: ${json?.error_description ?? json?.error ?? `HTTP ${res.status}`}`,
      );
    }
    return json;
  }

  /** Format a Google Ads API error so DEVELOPER_TOKEN_NOT_APPROVED etc. surface
   *  verbatim (the actionable detail lives in details[].errors[].message). */
  private gErr(status: number, json: any): string {
    const e = json?.error;
    const detail = e?.details?.[0]?.errors?.[0]?.message;
    return `Google Ads: ${detail || e?.message || `HTTP ${status}`}`;
  }
}
