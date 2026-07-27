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
 * Read-only wrapper around the Meta Marketing API (Ads Insights). Mirrors
 * FacebookApiService and REUSES the existing Meta app credentials by default
 * (`META_ADS_APP_ID/SECRET` fall back to `FACEBOOK_APP_ID/SECRET`) — the dealer
 * does not create a second Meta app, they just add the `ads_read` permission to
 * the existing one.
 *
 * Only `ads_read` is requested (read-only — no ads_management). Insights come
 * from `GET /act_<id>/insights` with `time_increment=1` for a daily trend and
 * `level=campaign` for the per-campaign breakdown.
 */
@Injectable()
export class MetaAdsApiService implements OnModuleInit {
  private readonly logger = new Logger(MetaAdsApiService.name);

  private appId = '';
  private appSecret = '';
  private redirectUri = '';
  private apiVersion = 'v20.0';
  private _devMode = true;

  static readonly REQUESTED_SCOPES = ['ads_read'];

  /** Action types we treat as "conversions" (Pixel/CAPI + lead actions). Meta's
   *  `actions` array is heterogeneous; we match by substring so common variants
   *  (offsite_conversion.fb_pixel_purchase, onsite_conversion.lead_grouped, …)
   *  all count. */
  private static readonly CONVERSION_HINTS = ['lead', 'purchase', 'complete_registration', 'conversion'];

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.appId =
      this.config.get<string>('META_ADS_APP_ID') ||
      this.config.get<string>('FACEBOOK_APP_ID') ||
      '';
    this.appSecret =
      this.config.get<string>('META_ADS_APP_SECRET') ||
      this.config.get<string>('FACEBOOK_APP_SECRET') ||
      '';
    this.redirectUri =
      this.config.get<string>('META_ADS_REDIRECT_URI') ||
      'http://localhost:8080/marketing/connect/meta/callback';
    this.apiVersion =
      this.config.get<string>('META_ADS_API_VERSION') ||
      this.config.get<string>('FACEBOOK_API_VERSION') ||
      'v20.0';

    const credsLookReal =
      !!this.appId &&
      !!this.appSecret &&
      this.appId !== 'your_facebook_app_id' &&
      this.appSecret !== 'your_facebook_app_secret' &&
      this.appId !== 'your_meta_ads_app_id' &&
      this.appSecret !== 'your_meta_ads_app_secret';

    if (!credsLookReal) {
      this._devMode = true;
      this.logger.warn(
        'META_ADS_/FACEBOOK_APP_ creds not configured — Meta Ads API running in dev mode (mock analytics; no real Graph calls).',
      );
      return;
    }

    this._devMode = false;
    this.logger.log(`📊 Meta Ads API ready (appId=${this.appId}, ${this.apiVersion})`);
  }

  get devMode(): boolean {
    return this._devMode;
  }

  /** Classic Facebook Login dialog requesting `ads_read`. Returns null in
   *  dev-mode. (Uses the classic `scope` param — ads_read is grantable that
   *  way; no Login-for-Business config_id needed for read-only insights.) */
  buildAuthUrl(state: string): string | null {
    if (this._devMode) return null;
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: MetaAdsApiService.REQUESTED_SCOPES.join(','),
      state,
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  /** Exchange code → short-lived → long-lived user token (~60d). */
  async exchangeCodeForTokens(code?: string): Promise<AdsOAuthResult> {
    if (this._devMode) {
      return { accessToken: 'dev-meta-user-token', refreshToken: '' };
    }
    if (!code) throw new BadRequestException('Missing Meta OAuth authorization code');

    const tokenRes = await this.graphGet('oauth/access_token', {
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: this.redirectUri,
      code,
    });
    let userToken: string = tokenRes?.access_token;
    if (!userToken) throw new ServiceUnavailableException('Meta did not return an access token');

    let expiresAt: Date | undefined;
    try {
      const ll = await this.graphGet('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: userToken,
      });
      if (ll?.access_token) userToken = ll.access_token;
      if (ll?.expires_in) expiresAt = new Date(Date.now() + ll.expires_in * 1000);
    } catch (err) {
      this.logger.warn(
        `Meta long-lived token exchange failed; using short-lived token: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    return { accessToken: userToken, refreshToken: '', expiresAt };
  }

  /** Ad accounts the connected user can read. */
  async listAdAccounts(accessToken: string): Promise<AdAccountSummary[]> {
    if (this._devMode) {
      return [
        { accountId: 'act_2186925942043427', accountName: 'Dev Meta Ad Account', currency: 'USD' },
      ];
    }
    const r = await this.graphGet('me/adaccounts', {
      fields: 'id,name,currency,account_status',
      access_token: accessToken,
    });
    const data: any[] = Array.isArray(r?.data) ? r.data : [];
    return data.map((a) => ({
      accountId: String(a.id), // already `act_<id>`
      accountName: a.name ?? a.id,
      currency: a.currency ?? '',
    }));
  }

  /** Daily per-campaign insights. Dev-mode returns deterministic mocks. */
  async fetchInsights(opts: FetchInsightsOptions): Promise<AdInsightRow[]> {
    if (this._devMode) return mockInsightRows('meta', opts.startDate, opts.endDate);
    if (!opts.accessToken) throw new BadRequestException('Missing Meta access token');
    if (!opts.accountId) throw new BadRequestException('Missing Meta ad account id');

    const actId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;
    const rows: AdInsightRow[] = [];
    let after: string | undefined;
    let guard = 0;

    do {
      const params: Record<string, string> = {
        level: 'campaign',
        time_increment: '1',
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
        time_range: JSON.stringify({ since: opts.startDate, until: opts.endDate }),
        limit: '500',
        access_token: opts.accessToken,
      };
      if (after) params.after = after;

      const r = await this.graphGet(`${actId}/insights`, params);
      const data: any[] = Array.isArray(r?.data) ? r.data : [];
      for (const row of data) {
        rows.push({
          date: row?.date_start ?? '',
          campaignId: String(row?.campaign_id ?? ''),
          campaignName: row?.campaign_name ?? '',
          spend: Number(row?.spend ?? 0),
          impressions: Number(row?.impressions ?? 0),
          clicks: Number(row?.clicks ?? 0),
          conversions: this.sumActions(row?.actions),
          conversionValue: this.sumActions(row?.action_values),
        });
      }
      after = r?.paging?.cursors?.after && r?.paging?.next ? r.paging.cursors.after : undefined;
    } while (after && ++guard < 20);

    return rows;
  }

  /** Sum the values of action rows whose action_type looks like a conversion. */
  private sumActions(actions: any): number {
    if (!Array.isArray(actions)) return 0;
    return actions
      .filter((a) =>
        MetaAdsApiService.CONVERSION_HINTS.some((h) => String(a?.action_type ?? '').includes(h)),
      )
      .reduce((sum, a) => sum + Number(a?.value ?? 0), 0);
  }

  private async graphGet(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${path}?${qs}`);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const e = json?.error;
      const parts: string[] = [e?.message ?? `Graph request failed (HTTP ${res.status})`];
      if (e?.error_user_msg && e.error_user_msg !== e?.message) parts.push(e.error_user_msg);
      const code = [e?.code, e?.error_subcode].filter((x) => x != null).join('/');
      if (code) parts.push(`[code ${code}]`);
      throw new ServiceUnavailableException(`Meta Ads: ${parts.join(' — ')}`);
    }
    return json;
  }
}
