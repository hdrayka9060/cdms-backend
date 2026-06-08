import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * A connectable Facebook destination (a Page the dealer manages), as returned
 * by the OAuth exchange. `accessToken` is the long-lived Page token — the
 * caller (FacebookService) encrypts it before persisting.
 */
export interface FacebookPageConnectionInput {
  pageId: string;
  pageName: string;
  accessToken: string;
  scopes: string[];
  businessId?: string;
  catalogId?: string;
  tokenExpiresAt?: Date;
}

/**
 * Cross-cutting wrapper around the Facebook Graph API. Registered `@Global()`
 * (see FacebookApiModule) so every Facebook-related feature service —
 * publishing, the insights cron, webhook ingest in later phases — can inject
 * it without importing the module, exactly like MailService / GoogleMeetService.
 *
 * Dev-mode fallback (mirrors MailService): when the FACEBOOK_APP_* creds are
 * unset or still the seeded `your_facebook_*` placeholders, `devMode = true`
 * and the service mints deterministic MOCK data instead of calling Graph. This
 * keeps the entire connect → publish → inbox flow testable before the Meta app
 * + Business Verification exist (the dealership starts from scratch).
 *
 * Phase 0a implements ONLY the dev-mode paths. The real-mode branches
 * (OAuth dialog URL + code→token exchange) are stubbed to throw a clear error
 * and land in Phase 0b once a live Meta app is available.
 */
@Injectable()
export class FacebookApiService implements OnModuleInit {
  private readonly logger = new Logger(FacebookApiService.name);

  private appId = '';
  private appSecret = '';
  private configId = '';
  private redirectUri = '';
  private apiVersion = 'v20.0';
  private _devMode = true;

  /**
   * Scopes (permissions) the connect flow will request from Facebook in
   * real-mode. Centralised here so the OAuth URL (0b) and the activity/UI
   * surfaces share one source of truth.
   */
  static readonly REQUESTED_SCOPES = [
    'pages_show_list',
    'pages_manage_posts',
    'pages_read_engagement',
    // Reading the *content* of users' comments (author + message) on Page posts
    // is a DISTINCT permission from pages_read_engagement. pages_read_engagement
    // only exposes the comment COUNT (comments.summary(total_count)) — which is
    // why Engagement shows e.g. "5 comments" — but enumerating /{post}/comments
    // returns nothing without pages_read_user_content. Without this, the
    // facebook_comments collection never fills and the per-listing unread badge
    // stays at 0. (NB for Login-for-Business / config_id connects: this must
    // ALSO be added to the Meta configuration + the Page reconnected — the
    // config defines the granted set, not the `scope` param. See buildAuthUrl.)
    'pages_read_user_content',
    'pages_manage_engagement',
    'pages_messaging',
    'business_management',
  ];

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.appId = this.config.get<string>('FACEBOOK_APP_ID') ?? '';
    this.appSecret = this.config.get<string>('FACEBOOK_APP_SECRET') ?? '';
    this.configId = this.config.get<string>('FACEBOOK_CONFIG_ID') ?? '';
    this.redirectUri = this.config.get<string>('FACEBOOK_REDIRECT_URI') ?? '';
    this.apiVersion = this.config.get<string>('FACEBOOK_API_VERSION') || 'v20.0';

    // Treat unset / placeholder creds as dev mode — same philosophy as
    // MailService.onModuleInit and GoogleMeetService.onModuleInit.
    const credsLookReal =
      !!this.appId &&
      !!this.appSecret &&
      this.appId !== 'your_facebook_app_id' &&
      this.appSecret !== 'your_facebook_app_secret' &&
      this.configId !== 'your_facebook_config_id';

    if (!credsLookReal) {
      this._devMode = true;
      this.logger.warn(
        'FACEBOOK_APP_ID/APP_SECRET/CONFIG_ID not fully configured — Facebook API running in dev mode (connect mints a mock Page; no real Graph calls).',
      );
      return;
    }

    this._devMode = false;
    this.logger.log(`📘 Facebook API ready (appId=${this.appId}, ${this.apiVersion})`);
  }

  /** True when running against mock data (no live Meta app configured). */
  get devMode(): boolean {
    return this._devMode;
  }

  /** Convenience inverse, mirrors GoogleMeetService.isEnabled(). */
  isEnabled(): boolean {
    return !this._devMode;
  }

  /**
   * Build the Facebook Login dialog URL the browser is redirected to.
   * Returns `null` in dev-mode (the frontend then simulates the connect
   * instead of redirecting). Real value is exercised in Phase 0b.
   */
  buildAuthUrl(state: string): string | null {
    if (this._devMode) return null;
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      state,
      response_type: 'code',
    });
    if (this.configId) {
      // Facebook Login for Business: the requested permission set is defined by
      // the *configuration*, NOT a `scope` param. Sending `scope` alongside a
      // config_id makes Facebook reject the dialog with "Invalid Scopes"
      // (pages_manage_posts / pages_read_engagement / pages_manage_engagement
      // are business-login-only and aren't grantable via the classic scope
      // param). The config_id alone carries them.
      params.set('config_id', this.configId);
    } else {
      // Classic Facebook Login fallback (no configuration): request via scope.
      params.set('scope', FacebookApiService.REQUESTED_SCOPES.join(','));
    }
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  /**
   * Exchange an OAuth `code` for the dealer's connectable Pages (each with its
   * long-lived Page access token).
   *
   * Phase 0a: dev-mode only — returns a single deterministic mock Page so the
   * connect UI works end-to-end. Real-mode (live creds) is intentionally not
   * implemented yet; it throws so it can never silently no-op. The real
   * code→token→`/me/accounts` exchange lands in Phase 0b.
   */
  async exchangeCodeForConnections(
    code?: string,
  ): Promise<FacebookPageConnectionInput[]> {
    if (this._devMode) {
      return this.mockConnections();
    }
    if (!code) throw new BadRequestException('Missing OAuth authorization code');

    // 1. Exchange the code for a short-lived USER access token.
    const tokenRes = await this.graphGet('oauth/access_token', {
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: this.redirectUri,
      code,
    });
    let userToken: string = tokenRes?.access_token;
    if (!userToken) {
      throw new ServiceUnavailableException('Facebook did not return an access token');
    }

    // 2. Upgrade to a long-lived user token (best-effort). Page tokens derived
    //    from a long-lived user token don't expire; fall back to short-lived.
    try {
      const ll = await this.graphGet('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: userToken,
      });
      if (ll?.access_token) userToken = ll.access_token;
    } catch (err) {
      this.logger.warn(
        `Long-lived token exchange failed; using short-lived token: ${err instanceof Error ? err.message : err}`,
      );
    }

    // 3. List the Pages this user manages — each carries its own Page token.
    const pagesRes = await this.graphGet('me/accounts', {
      access_token: userToken,
      fields: 'id,name,access_token',
    });
    const pages: any[] = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
    if (!pages.length) {
      throw new ServiceUnavailableException(
        'No Facebook Pages found for this account. The dealer must manage at least one Page.',
      );
    }

    return pages
      .filter((p) => p?.id && p?.access_token)
      .map((p) => ({
        pageId: String(p.id),
        pageName: p.name ?? 'Facebook Page',
        accessToken: p.access_token as string,
        scopes: FacebookApiService.REQUESTED_SCOPES,
      }));
  }

  /** Deterministic mock connection used in dev-mode. */
  private mockConnections(): FacebookPageConnectionInput[] {
    return [
      {
        pageId: 'dev-page-1',
        pageName: 'ABC Motors (Dev)',
        accessToken: 'dev-mock-page-access-token',
        scopes: FacebookApiService.REQUESTED_SCOPES,
        businessId: 'dev-business-1',
        catalogId: 'dev-catalog-1',
      },
    ];
  }

  /** Minimal Graph GET helper. Throws a 503 carrying the Facebook error
   *  message on any non-OK / error response so the admin sees the real cause. */
  /**
   * Build a rich, actionable message from a Graph error payload. Graph's terse
   * `error.message` (e.g. "Cannot call API for app … on behalf of user …")
   * often omits the human-facing `error_user_msg`, which spells out the real
   * cause/fix; we also append the `code`/`error_subcode` so a failure is
   * diagnosable from `listing.lastError` alone (no need to dig through logs).
   */
  private graphErrorMessage(status: number, json: any): string {
    const e = json?.error;
    const parts: string[] = [e?.message ?? `Graph request failed (HTTP ${status})`];
    if (e?.error_user_msg && e.error_user_msg !== e?.message) parts.push(e.error_user_msg);
    const code = [e?.code, e?.error_subcode]
      .filter((x) => x !== undefined && x !== null)
      .join('/');
    if (code) parts.push(`[code ${code}]`);
    return `Facebook: ${parts.join(' — ')}`;
  }

  private async graphGet(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `https://graph.facebook.com/${this.apiVersion}/${path}?${qs}`;
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      throw new ServiceUnavailableException(this.graphErrorMessage(res.status, json));
    }
    return json;
  }

  // ── Publishing ─────────────────────────────────────────────────────────────

  /**
   * Publish a post to a Page. Dev-mode returns a deterministic mock post id +
   * permalink so the whole compose→publish→listing loop works without a live
   * app. Real-mode posts the first photo (with caption) to `/{pageId}/photos`,
   * or a text post to `/{pageId}/feed` when there are no photos. (Multi-photo
   * albums are deferred to a later phase.)
   *
   * NOTE (real-mode): Facebook fetches `imageUrls` over the public internet, so
   * they must be publicly reachable absolute URLs — i.e. the S3/Cloudinary
   * migration (NEXT_STEPS #4) is a prerequisite for real photo posts; local
   * `/uploads` paths won't resolve for Facebook.
   */
  async publishToPage(
    pageId: string,
    pageToken: string,
    content: { message: string; link?: string; imageUrls?: string[] },
  ): Promise<{ postId: string; permalink: string }> {
    if (this._devMode) {
      const id = `dev-post-${Date.now()}`;
      return { postId: id, permalink: `https://www.facebook.com/${pageId}/posts/${id}` };
    }

    // Only absolute http(s) URLs are usable — Facebook fetches the image over
    // the public internet. Drop the mapper's "🚗" emoji fallback and any
    // relative /uploads path (which 400s with "url should represent a valid
    // URL"); if nothing valid remains we fall through to a text post.
    const imageUrls = (content.imageUrls ?? []).filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u),
    );
    if (imageUrls.length) {
      const r = await this.graphPost(`${pageId}/photos`, {
        url: imageUrls[0],
        caption: content.message ?? '',
        published: 'true',
        access_token: pageToken,
      });
      const postId = String(r.post_id ?? r.id);
      return { postId, permalink: `https://www.facebook.com/${postId}` };
    }

    const r = await this.graphPost(`${pageId}/feed`, {
      message: content.message ?? '',
      ...(content.link ? { link: content.link } : {}),
      access_token: pageToken,
    });
    return { postId: String(r.id), permalink: `https://www.facebook.com/${r.id}` };
  }

  /** Delete a Page post. Dev-mode no-ops (returns true). */
  async deletePagePost(pageToken: string, postId: string): Promise<boolean> {
    if (this._devMode) return true;
    if (!postId) return false;
    await this.graphDelete(postId, { access_token: pageToken });
    return true;
  }

  /** Update a Page post's message text. Dev-mode no-ops. Note: Facebook only
   *  allows editing the *text* of a feed post — photos can't be changed after
   *  publish (a photo change is a remove + re-publish). */
  async updatePagePost(pageToken: string, postId: string, message: string): Promise<boolean> {
    if (this._devMode) return true;
    if (!postId) return false;
    await this.graphPost(postId, { message, access_token: pageToken });
    return true;
  }

  // ── Engagement & comments ────────────────────────────────────────────────

  /** Current engagement counts for a post. Dev-mode returns deterministic mock
   *  numbers; real-mode reads reaction/comment/share summaries from Graph.
   *  (Post impressions/views need a separate /insights call — deferred.) */
  async fetchPostInsights(
    pageToken: string,
    postId: string,
  ): Promise<{ reactions: number; comments: number; shares: number; views: number }> {
    if (this._devMode) {
      return { reactions: 12, comments: 2, shares: 1, views: 240 };
    }
    const r = await this.graphGet(postId, {
      fields: 'reactions.summary(total_count),comments.summary(total_count),shares',
      access_token: pageToken,
    });
    return {
      reactions: r?.reactions?.summary?.total_count ?? 0,
      comments: r?.comments?.summary?.total_count ?? 0,
      shares: r?.shares?.count ?? 0,
      views: 0,
    };
  }

  /** Comments on a post. Dev-mode returns one deterministic sample comment so
   *  the inbox is testable without a live app; real-mode reads from Graph. */
  async fetchPostComments(
    pageToken: string,
    postId: string,
  ): Promise<
    Array<{ id: string; authorName: string; authorId: string; message: string; createdTime?: string }>
  > {
    if (this._devMode) {
      return [
        {
          id: `dev-cmt-${postId}-1`,
          authorName: 'Jamie Buyer',
          authorId: 'dev-user-1',
          message: 'Is this still available? What is the best price?',
          createdTime: undefined,
        },
      ];
    }
    const r = await this.graphGet(`${postId}/comments`, {
      fields: 'id,from,message,created_time',
      access_token: pageToken,
    });
    const data: any[] = Array.isArray(r?.data) ? r.data : [];
    return data.map((c) => ({
      id: String(c.id),
      authorName: c?.from?.name ?? 'Facebook user',
      authorId: c?.from?.id ?? '',
      message: c?.message ?? '',
      createdTime: c?.created_time,
    }));
  }

  /** Reply to a comment. Dev-mode no-ops (returns a mock id). */
  async replyToComment(
    pageToken: string,
    commentId: string,
    message: string,
  ): Promise<{ id: string }> {
    if (this._devMode) return { id: `dev-reply-${commentId}` };
    const r = await this.graphPost(`${commentId}/comments`, {
      message,
      access_token: pageToken,
    });
    return { id: String(r.id) };
  }

  // ── Messenger ────────────────────────────────────────────────────────────

  /** List the Page's Messenger conversations (also where Marketplace chat leads
   *  land). Dev-mode returns one deterministic sample thread; real-mode uses the
   *  Conversations API. */
  async fetchConversations(
    pageId: string,
    pageToken: string,
  ): Promise<
    Array<{
      id: string;
      participantName: string;
      participantId: string;
      snippet: string;
      updatedTime?: string;
      unreadCount: number;
    }>
  > {
    if (this._devMode) {
      return [
        {
          id: `dev-conv-${pageId}-1`,
          participantName: 'Alex Shopper',
          participantId: 'dev-psid-1',
          snippet: 'Hi, is the Civic still available?',
          updatedTime: undefined,
          unreadCount: 1,
        },
      ];
    }
    const r = await this.graphGet(`${pageId}/conversations`, {
      platform: 'messenger',
      fields: 'id,participants,snippet,updated_time,unread_count',
      access_token: pageToken,
    });
    const data: any[] = Array.isArray(r?.data) ? r.data : [];
    return data.map((c) => {
      const parts: any[] = c?.participants?.data ?? [];
      const other = parts.find((p) => p?.id && p.id !== pageId) ?? parts[0] ?? {};
      return {
        id: String(c.id),
        participantName: other?.name ?? 'Facebook user',
        participantId: other?.id ?? '',
        snippet: c?.snippet ?? '',
        updatedTime: c?.updated_time,
        unreadCount: c?.unread_count ?? 0,
      };
    });
  }

  /** Messages in a conversation. Dev-mode returns one inbound sample. */
  async fetchMessages(
    pageToken: string,
    conversationId: string,
  ): Promise<
    Array<{ id: string; fromId: string; fromName: string; text: string; createdTime?: string }>
  > {
    if (this._devMode) {
      return [
        {
          id: `dev-msg-${conversationId}-1`,
          fromId: 'dev-psid-1',
          fromName: 'Alex Shopper',
          text: 'Hi, is the Civic still available? Can I see it this weekend?',
          createdTime: undefined,
        },
      ];
    }
    const r = await this.graphGet(`${conversationId}/messages`, {
      fields: 'id,from,message,created_time',
      access_token: pageToken,
    });
    const data: any[] = Array.isArray(r?.data) ? r.data : [];
    return data.map((m) => ({
      id: String(m.id),
      fromId: m?.from?.id ?? '',
      fromName: m?.from?.name ?? '',
      text: m?.message ?? '',
      createdTime: m?.created_time,
    }));
  }

  /** Send a message to a person via the Send API. Dev-mode no-ops (mock id).
   *  `recipientId` is the person's PSID. Subject to the 24h standard messaging
   *  window in real-mode (Facebook rejects sends outside it). */
  async sendMessage(
    pageId: string,
    pageToken: string,
    recipientId: string,
    text: string,
  ): Promise<{ id: string }> {
    if (this._devMode) return { id: `dev-msg-out-${Date.now()}` };
    const r = await this.graphPost(`${pageId}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      messaging_type: 'RESPONSE',
      message: JSON.stringify({ text }),
      access_token: pageToken,
    });
    return { id: String(r?.message_id ?? r?.id ?? '') };
  }

  // ── Marketplace catalog (Item API) ───────────────────────────────────────

  /**
   * Upsert (CREATE/UPDATE) or DELETE a single vehicle item in a product catalog
   * via the Marketplace Partner Item API (`/{catalog}/items_batch`). Dev-mode
   * no-ops. Real-mode is gated on an approved Marketplace partner + a catalog id,
   * and image URLs must be publicly reachable (the S3 prerequisite — local
   * /uploads paths won't resolve for Facebook).
   */
  async syncCatalogItem(
    catalogId: string,
    accessToken: string,
    item: Record<string, any>,
    op: 'CREATE' | 'UPDATE' | 'DELETE' = 'CREATE',
  ): Promise<{ retailerId: string }> {
    const retailerId = String(item.id ?? item.retailer_id ?? '');
    if (this._devMode) return { retailerId: retailerId || `dev-item-${Date.now()}` };
    await this.graphPost(`${catalogId}/items_batch`, {
      item_type: 'VEHICLE',
      requests: JSON.stringify([{ method: op, data: item }]),
      access_token: accessToken,
    });
    return { retailerId };
  }

  /** Remove an item from a product catalog. Dev-mode no-ops. */
  async deleteCatalogItem(
    catalogId: string,
    accessToken: string,
    retailerId: string,
  ): Promise<boolean> {
    if (this._devMode) return true;
    if (!retailerId) return false;
    await this.graphPost(`${catalogId}/items_batch`, {
      item_type: 'VEHICLE',
      requests: JSON.stringify([{ method: 'DELETE', data: { id: retailerId } }]),
      access_token: accessToken,
    });
    return true;
  }

  private async graphPost(path: string, params: Record<string, string>): Promise<any> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      throw new ServiceUnavailableException(this.graphErrorMessage(res.status, json));
    }
    return json;
  }

  private async graphDelete(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `https://graph.facebook.com/${this.apiVersion}/${path}?${qs}`;
    const res = await fetch(url, { method: 'DELETE' });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      throw new ServiceUnavailableException(this.graphErrorMessage(res.status, json));
    }
    return json;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  get webhookVerifyToken(): string {
    return this.config.get<string>('FACEBOOK_VERIFY_TOKEN') ?? '';
  }

  /** Validates the GET verification handshake Facebook performs when a webhook
   *  is subscribed (the caller echoes `hub.challenge` iff this returns true). */
  verifyWebhookChallenge(mode?: string, token?: string): boolean {
    const expected = this.webhookVerifyToken;
    return mode === 'subscribe' && !!expected && token === expected;
  }

  /** Verifies the `X-Hub-Signature-256` header on an incoming webhook POST
   *  against the RAW request body (HMAC-SHA256 keyed with the app secret).
   *  Returns false when no app secret is configured (dev-mode) or the header is
   *  missing — real webhooks only originate from Facebook in real-mode. */
  verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
    if (!this.appSecret || !signatureHeader) return false;
    const expected =
      'sha256=' + createHmac('sha256', this.appSecret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
