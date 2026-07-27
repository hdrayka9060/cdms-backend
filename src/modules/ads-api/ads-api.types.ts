/**
 * Shared types for the read-only ads-analytics integration (Google Ads + Meta
 * Ads). Both provider wrappers (GoogleAdsApiService / MetaAdsApiService) speak
 * the same normalized `AdInsightRow` shape so AdsAnalyticsService can treat them
 * uniformly. Mirrors the Facebook integration's "one wrapper service per
 * platform, dev-mode fallback" pattern — but everything here is READ-ONLY
 * (insights only; no campaign create/edit/spend control, by design).
 */

/** A connectable ad account, as returned after the OAuth exchange. */
export interface AdAccountSummary {
  /** Google: digits-only customer id (e.g. 6765726290). Meta: `act_<id>`. */
  accountId: string;
  accountName: string;
  currency: string;
}

/** Result of exchanging an OAuth `code`. Meta uses `accessToken` (long-lived
 *  user token, ~60d); Google uses `refreshToken` (minted access tokens on
 *  demand). The unused field is simply empty for that provider. */
export interface AdsOAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt?: Date;
}

/** One day of metrics for one campaign, normalized across providers. CTR / CPC
 *  / cost-per-conversion / ROAS are derived downstream from these sums (so we
 *  never divide-by-zero at the source). */
export interface AdInsightRow {
  date: string; // YYYY-MM-DD
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}

export interface FetchInsightsOptions {
  accountId: string; // Google: customer id (digits). Meta: act_<id>.
  refreshToken?: string; // Google
  accessToken?: string; // Meta
  loginCustomerId?: string; // Google MCC (digits), optional
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

/**
 * Deterministic mock insights for dev-mode (no real ad-platform creds). Returns
 * one row per day in [startDate, endDate] for two sample campaigns, seeded from
 * the date string so the same window always renders the same numbers — keeps
 * the whole connect → sync → analytics loop testable before Meta App Review /
 * Google Basic-Access land (the project's standard dev-mode philosophy).
 */
export function mockInsightRows(
  provider: 'google' | 'meta',
  startDate: string,
  endDate: string,
): AdInsightRow[] {
  const rows: AdInsightRow[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return rows;

  const campaigns =
    provider === 'google'
      ? [
          { id: 'g-search-1', name: 'Search — Used Inventory' },
          { id: 'g-pmax-1', name: 'Performance Max — Brand' },
        ]
      : [
          { id: 'm-traffic-1', name: 'Traffic — Inventory' },
          { id: 'm-leads-1', name: 'Lead Form — Test Drives' },
        ];

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const daySeed = [...date].reduce((a, c) => a + c.charCodeAt(0), 0);
    campaigns.forEach((c, i) => {
      const seed = daySeed + i * 37 + (provider === 'google' ? 0 : 11);
      const impressions = 800 + (seed % 1200);
      const clicks = 20 + (seed % 80);
      const spend = Math.round((30 + (seed % 170) + clicks * 0.6) * 100) / 100;
      const conversions = Math.max(0, Math.round(clicks * 0.08) + (seed % 3));
      rows.push({
        date,
        campaignId: c.id,
        campaignName: c.name,
        impressions,
        clicks,
        spend,
        conversions,
        conversionValue: Math.round(conversions * (200 + (seed % 300)) * 100) / 100,
      });
    });
  }
  return rows;
}
