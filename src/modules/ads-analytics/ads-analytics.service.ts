import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model, Types, isValidObjectId } from 'mongoose';
import {
  AdsConnection,
  AdsConnectionDocument,
  AdsConnectionStatus,
  AdsProvider,
} from './schemas/ads-connection.schema';
import {
  AdsInsightSnapshot,
  AdsInsightSnapshotDocument,
} from './schemas/ads-insight-snapshot.schema';
import { GoogleAdsApiService } from '../ads-api/google-ads-api.service';
import { MetaAdsApiService } from '../ads-api/meta-ads-api.service';
import { AdAccountSummary, AdInsightRow } from '../ads-api/ads-api.types';
import { ActivityService } from '../activity/activity.service';
import { decryptToken, encryptToken } from '../../common/crypto/token-cipher';
import { ConnectCallbackDto, UpdateAdsConnectionDto } from './dto/ads.dto';

/** A metric accumulator (the five raw sums; derived ratios added on read).
 *  Exported so the inferred analytics return type is nameable across modules. */
export interface MetricAcc {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}

/**
 * Read-only ad-analytics orchestration: connect (OAuth) → pull insights on a
 * cron → store append-only daily snapshots → aggregate for the Marketing tab.
 * No campaign create/edit/spend — analytics only.
 *
 * Mirrors FacebookService's connect/cron/activity shape. Tokens are encrypted
 * via the shared token-cipher; the Google/Meta Graph + GAQL calls live behind
 * the @Global GoogleAdsApiService / MetaAdsApiService wrappers (dev-mode safe).
 */
@Injectable()
export class AdsAnalyticsService {
  private readonly logger = new Logger(AdsAnalyticsService.name);
  private static readonly SYNC_WINDOW_DAYS = 30;

  constructor(
    @InjectModel(AdsConnection.name)
    private readonly connectionModel: Model<AdsConnectionDocument>,
    @InjectModel(AdsInsightSnapshot.name)
    private readonly snapshotModel: Model<AdsInsightSnapshotDocument>,
    private readonly google: GoogleAdsApiService,
    private readonly meta: MetaAdsApiService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService,
  ) {}

  // ── Connections ────────────────────────────────────────────────────────────

  /** All non-deleted connections, newest first. Token fields excluded (select:false). */
  async listConnections(): Promise<AdsConnectionDocument[]> {
    const docs = await this.connectionModel
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();
    return docs as unknown as AdsConnectionDocument[];
  }

  /** Step 1 of connect — returns the provider login URL (real-mode) or devMode. */
  startConnect(provider: AdsProvider): {
    provider: AdsProvider;
    devMode: boolean;
    authUrl: string | null;
    state: string;
  } {
    const api = provider === AdsProvider.META ? this.meta : this.google;
    // 16 random bytes hex — CSRF nonce echoed back on the callback.
    const state = [...Array(32)]
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join('');
    return { provider, devMode: api.devMode, authUrl: api.buildAuthUrl(state), state };
  }

  /**
   * Step 2 of connect — exchange the OAuth code, store the (encrypted) token,
   * auto-bind the configured/first ad account, kick off an initial sync.
   * Idempotent per provider (re-connecting refreshes the token).
   */
  async completeConnect(
    dto: ConnectCallbackDto,
    actorId?: string,
  ): Promise<{ connections: AdsConnectionDocument[]; accounts: AdAccountSummary[] }> {
    const provider = dto.provider;

    let accounts: AdAccountSummary[] = [];
    let chosen: AdAccountSummary | undefined;
    const set: Record<string, unknown> = {
      isDeleted: false,
      deletedAt: null,
      lastError: '',
    };

    if (provider === AdsProvider.META) {
      const oauth = await this.meta.exchangeCodeForTokens(dto.code);
      set.accessTokenEnc = encryptToken(oauth.accessToken);
      set.scopes = MetaAdsApiService.REQUESTED_SCOPES;
      if (oauth.expiresAt) set.tokenExpiresAt = oauth.expiresAt;

      accounts = await this.meta.listAdAccounts(oauth.accessToken);
      const configured = this.normalizeMetaId(this.config.get<string>('META_ADS_ACCOUNT_ID') ?? '');
      chosen = (configured && accounts.find((a) => a.accountId === configured)) || accounts[0];
    } else {
      const oauth = await this.google.exchangeCodeForTokens(dto.code);
      set.refreshTokenEnc = encryptToken(oauth.refreshToken);
      set.scopes = [GoogleAdsApiService.SCOPE];
      set.loginCustomerId = this.google.configuredLoginCustomerId;

      const configured = (this.config.get<string>('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(/-/g, '');
      // listAccessibleCustomers returns only DIRECTLY accessible accounts (the
      // manager / top-level accounts the login user owns) — NOT the child
      // accounts under an MCC. So when a report account is configured we must
      // TRUST it (it's queried via the login-customer-id header), rather than
      // requiring it to appear in the accessible list — otherwise we wrongly
      // fall back to the first accessible account (e.g. an un-enabled manager).
      try {
        accounts = await this.google.listAccessibleCustomers(oauth.refreshToken);
      } catch (err) {
        this.logger.warn(
          `Google listAccessibleCustomers failed (continuing with configured id): ${
            err instanceof Error ? err.message : err
          }`,
        );
        accounts = [];
      }
      if (configured) {
        chosen =
          accounts.find((a) => a.accountId === configured) ?? {
            accountId: configured,
            accountName: `Google Ads ${configured}`,
            currency: '',
          };
      } else {
        chosen = accounts[0];
      }
    }

    if (chosen) {
      set.accountId = chosen.accountId;
      set.accountName = chosen.accountName;
      set.currency = chosen.currency;
    }
    set.status = chosen ? AdsConnectionStatus.ACTIVE : AdsConnectionStatus.PENDING_ACCOUNT;
    if (actorId && isValidObjectId(actorId)) set.connectedBy = new Types.ObjectId(actorId);

    await this.connectionModel.updateOne(
      { provider },
      { $set: set, $setOnInsert: { provider } },
      { upsert: true },
    );

    const doc = await this.connectionModel.findOne({ provider, isDeleted: false });
    await this.activity.log({
      module: 'marketing',
      action: 'ads-connected',
      entity: 'AdsConnection',
      entityId: doc ? String(doc._id) : undefined,
      label: `${provider} ads — ${chosen?.accountName || chosen?.accountId || 'no account'}`,
      byId: actorId,
      meta: { provider, accountId: chosen?.accountId ?? '' },
    });

    // Initial sync so data appears immediately (best-effort — a Google
    // DEVELOPER_TOKEN_NOT_APPROVED here just lands in lastError).
    if (doc && chosen?.accountId) {
      try {
        await this.syncConnection(String(doc._id), actorId);
      } catch (err) {
        this.logger.warn(
          `Initial ads sync failed (${provider}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return { connections: await this.listConnections(), accounts };
  }

  /** List the ad accounts a connection's stored token can read (account picker). */
  async listAccountsForConnection(id: string): Promise<AdAccountSummary[]> {
    const conn = await this.requireConnectionWithTokens(id);
    if (conn.provider === AdsProvider.META) {
      return this.meta.listAdAccounts(decryptToken(conn.accessTokenEnc));
    }
    return this.google.listAccessibleCustomers(decryptToken(conn.refreshTokenEnc));
  }

  /** Bind / switch the reported ad account (then re-sync best-effort). */
  async updateConnection(
    id: string,
    dto: UpdateAdsConnectionDto,
    actorId?: string,
  ): Promise<AdsConnectionDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Ad connection not found');
    const conn = await this.connectionModel.findOne({ _id: id, isDeleted: false });
    if (!conn) throw new NotFoundException('Ad connection not found');

    const set: Record<string, unknown> = {};
    if (dto.accountId !== undefined) {
      set.accountId =
        conn.provider === AdsProvider.META
          ? this.normalizeMetaId(dto.accountId)
          : dto.accountId.replace(/-/g, '');
      set.status = dto.accountId ? AdsConnectionStatus.ACTIVE : AdsConnectionStatus.PENDING_ACCOUNT;
    }
    if (dto.accountName !== undefined) set.accountName = dto.accountName;
    if (dto.loginCustomerId !== undefined) set.loginCustomerId = dto.loginCustomerId.replace(/-/g, '');

    await this.connectionModel.updateOne({ _id: id }, { $set: set });

    if (set.accountId) {
      try {
        await this.syncConnection(id, actorId);
      } catch (err) {
        this.logger.warn(`Re-sync after account change failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    const updated = await this.connectionModel.findOne({ _id: id, isDeleted: false }).lean();
    return updated as unknown as AdsConnectionDocument;
  }

  /** Soft-delete a connection (and mark revoked). Snapshots are left for history. */
  async disconnect(id: string, actorId?: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Ad connection not found');
    const existing = await this.connectionModel.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Ad connection not found');

    await this.connectionModel.updateOne(
      { _id: id },
      { $set: { isDeleted: true, deletedAt: new Date(), status: AdsConnectionStatus.REVOKED } },
    );

    await this.activity.log({
      module: 'marketing',
      action: 'ads-disconnected',
      entity: 'AdsConnection',
      entityId: String(existing._id),
      label: `${existing.provider} ads — ${existing.accountName || existing.accountId}`,
      byId: actorId,
      meta: { provider: existing.provider },
    });
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  /** Pull insights for one connection and upsert daily snapshots. */
  async syncConnection(id: string, actorId?: string): Promise<number> {
    const conn = await this.requireConnectionWithTokens(id);
    if (!conn.accountId) {
      throw new BadRequestException('No ad account selected for this connection');
    }

    const { startDate, endDate } = this.rangeLastDays(AdsAnalyticsService.SYNC_WINDOW_DAYS);
    let rows: AdInsightRow[];
    try {
      if (conn.provider === AdsProvider.META) {
        rows = await this.meta.fetchInsights({
          accountId: conn.accountId,
          accessToken: decryptToken(conn.accessTokenEnc),
          startDate,
          endDate,
        });
      } else {
        rows = await this.google.fetchInsights({
          accountId: conn.accountId,
          refreshToken: decryptToken(conn.refreshTokenEnc),
          loginCustomerId: conn.loginCustomerId,
          startDate,
          endDate,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.connectionModel.updateOne({ _id: conn._id }, { $set: { lastError: msg } });
      throw err;
    }

    const now = new Date();
    for (const r of rows) {
      if (!r.date) continue;
      await this.snapshotModel.updateOne(
        { provider: conn.provider, accountId: conn.accountId, date: r.date, campaignId: r.campaignId },
        {
          $set: {
            connection: conn._id,
            campaignName: r.campaignName,
            spend: r.spend,
            impressions: r.impressions,
            clicks: r.clicks,
            conversions: r.conversions,
            conversionValue: r.conversionValue,
            fetchedAt: now,
            isDeleted: false,
          },
        },
        { upsert: true },
      );
    }

    await this.connectionModel.updateOne(
      { _id: conn._id },
      { $set: { lastSyncedAt: now, lastError: '' } },
    );

    await this.activity.log({
      module: 'marketing',
      action: 'ads-synced',
      entity: 'AdsConnection',
      entityId: String(conn._id),
      label: `${conn.provider} ads — ${conn.accountName || conn.accountId}`,
      byId: actorId,
      meta: { provider: conn.provider, rows: rows.length },
    });

    this.logger.log(`Ads sync (${conn.provider}): ${rows.length} campaign-day rows`);
    return rows.length;
  }

  /** Sync all active connections (or one provider). */
  async sync(provider?: AdsProvider, actorId?: string): Promise<number> {
    const filter: Record<string, unknown> = { isDeleted: false, status: AdsConnectionStatus.ACTIVE };
    if (provider) filter.provider = provider;
    const conns = await this.connectionModel.find(filter);
    let total = 0;
    for (const c of conns) {
      try {
        total += await this.syncConnection(String(c._id), actorId);
      } catch (err) {
        this.logger.error(
          `Ads sync failed for ${c.provider} (${c._id}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return total;
  }

  /** Refresh every active connection a few times a day. Ad data lags ~hours and
   *  the API has quotas, so 6h (not the 30m the FB engagement cron uses). */
  @Cron(CronExpression.EVERY_6_HOURS)
  async cronSync(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.logger.error(`Scheduled ads sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  async getAnalytics(q: { startDate?: string; endDate?: string; provider?: AdsProvider }) {
    const endDate = q.endDate || this.dateStr(new Date());
    const startDate = q.startDate || this.rangeLastDays(AdsAnalyticsService.SYNC_WINDOW_DAYS).startDate;

    const filter: Record<string, unknown> = {
      isDeleted: false,
      date: { $gte: startDate, $lte: endDate },
    };
    if (q.provider) filter.provider = q.provider;

    const snaps = await this.snapshotModel.find(filter).lean();

    const summary = this.blank();
    const byPlatform = new Map<string, MetricAcc & { provider: string }>();
    const campaigns = new Map<string, MetricAcc & { provider: string; campaignId: string; campaignName: string }>();
    const trend = new Map<string, MetricAcc & { date: string }>();

    for (const s of snaps as any[]) {
      this.add(summary, s);

      const p = byPlatform.get(s.provider) ?? { provider: s.provider, ...this.blank() };
      this.add(p, s);
      byPlatform.set(s.provider, p);

      const ck = `${s.provider}:${s.campaignId}`;
      const c =
        campaigns.get(ck) ??
        { provider: s.provider, campaignId: s.campaignId, campaignName: s.campaignName, ...this.blank() };
      c.campaignName = s.campaignName || c.campaignName;
      this.add(c, s);
      campaigns.set(ck, c);

      const t = trend.get(s.date) ?? { date: s.date, ...this.blank() };
      this.add(t, s);
      trend.set(s.date, t);
    }

    const connections = await this.listConnections();

    return {
      range: { startDate, endDate },
      devMode: { google: this.google.devMode, meta: this.meta.devMode },
      summary: this.withDerived(summary),
      byPlatform: [...byPlatform.values()].map((p) => this.withDerived(p)),
      campaigns: [...campaigns.values()]
        .map((c) => this.withDerived(c))
        .sort((a, b) => b.spend - a.spend),
      trend: [...trend.values()].sort((a, b) => a.date.localeCompare(b.date)),
      connections: connections.map((c) => ({
        id: String((c as any)._id),
        provider: c.provider,
        accountId: c.accountId,
        accountName: c.accountName,
        currency: c.currency,
        status: c.status,
        lastSyncedAt: c.lastSyncedAt ?? null,
        lastError: c.lastError ?? '',
      })),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async requireConnectionWithTokens(id: string): Promise<AdsConnectionDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Ad connection not found');
    const conn = await this.connectionModel
      .findOne({ _id: id, isDeleted: false })
      .select('+accessTokenEnc +refreshTokenEnc');
    if (!conn) throw new NotFoundException('Ad connection not found');
    return conn;
  }

  private blank(): MetricAcc {
    return { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
  }

  private add(target: MetricAcc, s: MetricAcc): void {
    target.spend += s.spend ?? 0;
    target.impressions += s.impressions ?? 0;
    target.clicks += s.clicks ?? 0;
    target.conversions += s.conversions ?? 0;
    target.conversionValue += s.conversionValue ?? 0;
  }

  private withDerived<T extends MetricAcc>(m: T) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ...m,
      spend: r2(m.spend),
      conversionValue: r2(m.conversionValue),
      ctr: m.impressions ? r2((m.clicks / m.impressions) * 100) : 0,
      cpc: m.clicks ? r2(m.spend / m.clicks) : 0,
      costPerConversion: m.conversions ? r2(m.spend / m.conversions) : 0,
      roas: m.spend ? r2(m.conversionValue / m.spend) : 0,
    };
  }

  private dateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private rangeLastDays(n: number): { startDate: string; endDate: string } {
    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - (n - 1));
    return { startDate: this.dateStr(start), endDate: this.dateStr(end) };
  }

  private normalizeMetaId(id: string): string {
    if (!id) return '';
    return id.startsWith('act_') ? id : `act_${id}`;
  }
}
