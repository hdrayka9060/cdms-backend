import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model, Types, isValidObjectId } from 'mongoose';
import { randomBytes } from 'crypto';
import { LeadsService } from '../leads/leads.service';
import { LeadSource, LeadStatus } from '../leads/schemas/lead.schema';
import { CrmBuyersService } from '../crm-buyers/crm-buyers.service';
import { BuyerLeadStage } from '../crm-buyers/schemas/buyer-lead.schema';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import {
  DealerSettings,
  DealerSettingsDocument,
} from '../settings/schemas/dealer-settings.schema';
import {
  FacebookConnection,
  FacebookConnectionDocument,
  FacebookConnectionStatus,
} from './schemas/facebook-connection.schema';
import {
  FacebookListing,
  FacebookListingDocument,
  FacebookListingStatus,
  FacebookDestinationType,
} from './schemas/facebook-listing.schema';
import {
  FacebookListingTemplate,
  FacebookListingTemplateDocument,
} from './schemas/facebook-listing-template.schema';
import {
  FacebookComment,
  FacebookCommentDocument,
  FacebookCommentStatus,
} from './schemas/facebook-comment.schema';
import {
  FacebookConversation,
  FacebookConversationDocument,
  FacebookLeadStatus,
} from './schemas/facebook-conversation.schema';
import {
  FacebookMessage,
  FacebookMessageDocument,
  FacebookMessageDirection,
} from './schemas/facebook-message.schema';
import {
  FacebookGroupTarget,
  FacebookGroupTargetDocument,
} from './schemas/facebook-group-target.schema';
import {
  FacebookEngagement,
  FacebookEngagementDocument,
} from './schemas/facebook-engagement.schema';
import {
  CompleteConnectDto,
  CreateGroupTargetDto,
  CreateListingDto,
  CreateTemplateDto,
  PromoteLeadDto,
  UpdateConversationDto,
  UpdateListingDto,
} from './dto/facebook.dto';
import { ActivityService } from '../activity/activity.service';
import { FacebookApiService } from '../facebook-api/facebook-api.service';
import { decryptToken, encryptToken } from '../../common/crypto/token-cipher';

/**
 * Manages connected Facebook Pages (the "Destinations" surface of the Facebook
 * Listings feature). Phase 0a: list + connect (dev-mode mock) + disconnect.
 * Publishing, engagement, inbox, Marketplace catalog come in later phases.
 */
@Injectable()
export class FacebookService {
  private readonly logger = new Logger(FacebookService.name);

  constructor(
    @InjectModel(FacebookConnection.name)
    private readonly connectionModel: Model<FacebookConnectionDocument>,
    @InjectModel(FacebookListing.name)
    private readonly listingModel: Model<FacebookListingDocument>,
    @InjectModel(FacebookListingTemplate.name)
    private readonly templateModel: Model<FacebookListingTemplateDocument>,
    @InjectModel(FacebookComment.name)
    private readonly commentModel: Model<FacebookCommentDocument>,
    @InjectModel(FacebookConversation.name)
    private readonly conversationModel: Model<FacebookConversationDocument>,
    @InjectModel(FacebookMessage.name)
    private readonly messageModel: Model<FacebookMessageDocument>,
    @InjectModel(Vehicle.name)
    private readonly vehicleModel: Model<VehicleDocument>,
    @InjectModel(DealerSettings.name)
    private readonly settingsModel: Model<DealerSettingsDocument>,
    @InjectModel(FacebookGroupTarget.name)
    private readonly groupTargetModel: Model<FacebookGroupTargetDocument>,
    @InjectModel(FacebookEngagement.name)
    private readonly engagementModel: Model<FacebookEngagementDocument>,
    private readonly activity: ActivityService,
    private readonly fb: FacebookApiService,
    private readonly leadsService: LeadsService,
    private readonly crmBuyers: CrmBuyersService,
  ) {}

  /** All active (non-deleted) connections, newest first. Token field is
   *  excluded automatically (`select: false`). */
  async listConnections(): Promise<FacebookConnectionDocument[]> {
    const docs = await this.connectionModel
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();
    return docs as unknown as FacebookConnectionDocument[];
  }

  /**
   * Step 1 of connect. Returns the Facebook login URL to redirect to
   * (real-mode) or `devMode: true` (the frontend then simulates the connect by
   * calling completeConnect directly). `state` is a CSRF nonce echoed back on
   * the callback (validated in Phase 0b).
   */
  startConnect(): { devMode: boolean; authUrl: string | null; state: string } {
    const state = randomBytes(16).toString('hex');
    return { devMode: this.fb.devMode, authUrl: this.fb.buildAuthUrl(state), state };
  }

  /**
   * Step 2 of connect. Exchanges the OAuth code for the dealer's Page(s) and
   * persists each (access token AES-encrypted at rest). Idempotent per
   * `pageId` — re-connecting an existing Page re-activates its row rather than
   * duplicating. In dev-mode the exchange returns a deterministic mock Page.
   */
  async completeConnect(
    dto: CompleteConnectDto,
    actorId?: string,
  ): Promise<FacebookConnectionDocument[]> {
    const pages = await this.fb.exchangeCodeForConnections(dto.code);

    for (const page of pages) {
      const set: Record<string, unknown> = {
        pageName: page.pageName,
        businessId: page.businessId ?? '',
        catalogId: page.catalogId ?? '',
        scopes: page.scopes ?? [],
        pageAccessTokenEnc: encryptToken(page.accessToken),
        status: FacebookConnectionStatus.ACTIVE,
        isDeleted: false,
        deletedAt: null,
      };
      if (page.tokenExpiresAt) set.tokenExpiresAt = page.tokenExpiresAt;
      if (actorId && isValidObjectId(actorId)) {
        set.connectedBy = new Types.ObjectId(actorId);
      }

      await this.connectionModel.updateOne(
        { pageId: page.pageId },
        { $set: set, $setOnInsert: { pageId: page.pageId } },
        { upsert: true },
      );

      // Re-read for the activity entityId (token field stays excluded).
      const doc = await this.connectionModel.findOne({ pageId: page.pageId });
      await this.activity.log({
        module: 'facebook',
        action: 'facebook-connected',
        entity: 'Connection',
        entityId: doc ? String(doc._id) : undefined,
        label: `${page.pageName} (Facebook Page)`,
        byId: actorId,
        meta: { pageId: page.pageId },
      });
    }

    this.logger.log(
      `Facebook connect: ${pages.length} page(s) connected (devMode=${this.fb.devMode})`,
    );
    return this.listConnections();
  }

  /** Disconnect (soft-delete) a connection and mark it revoked. */
  async disconnect(id: string, actorId?: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Facebook connection not found');
    const existing = await this.connectionModel.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Facebook connection not found');

    await this.connectionModel.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          status: FacebookConnectionStatus.REVOKED,
        },
      },
    );

    await this.activity.log({
      module: 'facebook',
      action: 'facebook-disconnected',
      entity: 'Connection',
      entityId: id,
      label: `${existing.pageName} (Facebook Page)`,
      byId: actorId,
      meta: { pageId: existing.pageId },
    });
  }

  /**
   * Set (or clear) a connection's Marketplace product-catalog id. The catalog
   * enables the Marketplace (catalog) destination + the Item API sync for that
   * Page. The id comes from Meta Commerce Manager and isn't discoverable without
   * extra scopes, so the dealer pastes it in on the Destinations tab.
   */
  async setConnectionCatalog(
    id: string,
    opts: { catalogId?: string; catalogToken?: string },
  ): Promise<FacebookConnectionDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Facebook connection not found');
    const existing = await this.connectionModel.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Facebook connection not found');
    const set: Record<string, any> = {};
    if (opts.catalogId !== undefined) set.catalogId = opts.catalogId.trim();
    // Only touch the token when the field was sent. Non-empty → encrypt + store;
    // empty string → clear; undefined → leave the existing token untouched.
    if (opts.catalogToken !== undefined) {
      const t = opts.catalogToken.trim();
      set.catalogAccessTokenEnc = t ? encryptToken(t) : '';
    }
    if (Object.keys(set).length) {
      await this.connectionModel.updateOne({ _id: id }, { $set: set });
    }
    // The encrypted tokens are select:false, so this re-read never leaks them.
    return (await this.connectionModel.findOne({ _id: id })) as FacebookConnectionDocument;
  }

  /**
   * Phase 0b: a signature-verified webhook event lands here. For now we just
   * log + ack — actual ingestion (comments → `facebook_comments`, messages →
   * `facebook_conversations`, and Socket.io fan-out) lands in later phases.
   * Must stay fast and never throw (Facebook retries on a non-2xx response).
   */
  async handleWebhookEvent(payload: any): Promise<void> {
    try {
      const entries = Array.isArray(payload?.entry) ? payload.entry : [];
      let comments = 0;
      let messages = 0;
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const ch of changes) {
          if (ch?.field !== 'feed') continue;
          const v = ch.value ?? {};
          if (
            v.item === 'comment' &&
            (v.verb === 'add' || v.verb === 'edited') &&
            v.comment_id &&
            v.post_id
          ) {
            const listing = await this.listingModel.findOne({
              fbPostId: v.post_id,
              isDeleted: false,
            });
            if (!listing) continue;
            await this.upsertComment(listing, {
              id: String(v.comment_id),
              authorName: v.from?.name ?? 'Facebook user',
              authorId: v.from?.id ?? '',
              message: v.message ?? '',
              // Webhook timestamps are unix seconds; Graph fetch is ISO.
              createdTime: v.created_time
                ? new Date(Number(v.created_time) * 1000).toISOString()
                : undefined,
            });
            comments++;
          }
        }

        // Messenger messages arrive as `messaging[]`. We append to an EXISTING
        // conversation (matched by participant PSID + recipient Page); brand-new
        // threads are created on the next conversation-sync cron (which has the
        // conversation id the webhook doesn't carry).
        const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
        for (const m of messaging) {
          const msg = m?.message;
          if (!msg || msg.is_echo) continue;
          const psid = m?.sender?.id;
          const pageId = m?.recipient?.id;
          if (!psid || !pageId) continue;
          const conn = await this.connectionModel.findOne({ pageId, isDeleted: false });
          if (!conn) continue;
          const conv = await this.conversationModel.findOne({
            connection: conn._id,
            participantId: psid,
            isDeleted: false,
          });
          if (!conv) continue;
          const fbMessageId = msg.mid || `wh-${m.timestamp}-${psid}`;
          const exists = await this.messageModel.findOne({ fbMessageId });
          if (exists) continue;
          const createdAt = m.timestamp ? new Date(Number(m.timestamp)) : new Date();
          await this.messageModel.create({
            conversation: conv._id,
            fbMessageId,
            direction: FacebookMessageDirection.IN,
            text: msg.text ?? '',
            fbCreatedTime: createdAt,
          });
          await this.conversationModel.updateOne(
            { _id: conv._id },
            {
              $set: {
                lastInboundAt: createdAt,
                lastMessageAt: createdAt,
                snippet: (msg.text ?? '').slice(0, 200),
                unread: true,
              },
            },
          );
          messages++;
        }
      }
      this.logger.log(
        `Facebook webhook: object=${payload?.object ?? 'unknown'} comments=${comments} messages=${messages}`,
      );
    } catch (err) {
      this.logger.warn(`Webhook ingest failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Listings (Phase 1: publish to a connected Page) ──────────────────────

  /** List listings, newest first, with optional filters. */
  async listListings(
    filters: { status?: string; vehicleId?: string; connectionId?: string } = {},
  ): Promise<FacebookListingDocument[]> {
    const query: any = { isDeleted: false };
    if (filters.status) query.status = filters.status;
    if (filters.vehicleId && isValidObjectId(filters.vehicleId)) {
      query.vehicle = new Types.ObjectId(filters.vehicleId);
    }
    if (filters.connectionId && isValidObjectId(filters.connectionId)) {
      query.connection = new Types.ObjectId(filters.connectionId);
    }
    const docs = await this.listingModel.find(query).sort({ createdAt: -1 }).lean();
    // Attach each listing's unread-comment count (drives the row + tab badges).
    const ids = (docs as any[]).map((d) => d._id);
    if (ids.length) {
      const counts = await this.commentModel.aggregate([
        // `$ne: false` so comments predating the `unread` field count as unread.
        { $match: { listing: { $in: ids }, unread: { $ne: false }, isDeleted: false } },
        { $group: { _id: '$listing', count: { $sum: 1 } } },
      ]);
      const byListing = new Map<string, number>(
        counts.map((c: any) => [String(c._id), c.count]),
      );
      for (const d of docs as any[]) d.unreadComments = byListing.get(String(d._id)) ?? 0;
    }
    return docs as unknown as FacebookListingDocument[];
  }

  /**
   * Create one listing per target connection (fan-out). Publishes immediately
   * unless `publishNow === false` (saved as draft). A publish failure on one
   * destination marks that listing `failed` (with the reason) but never aborts
   * the others or 500s the request — the response carries each row's status.
   */
  async createListings(
    dto: CreateListingDto,
    actorId?: string,
  ): Promise<FacebookListingDocument[]> {
    if (!isValidObjectId(dto.vehicleId)) throw new BadRequestException('Invalid vehicleId');
    if (!dto.connectionIds?.length && !dto.groupTargetIds?.length) {
      throw new BadRequestException('Select at least one destination');
    }

    const createdIds: Types.ObjectId[] = [];
    for (const connId of dto.connectionIds ?? []) {
      const conn = await this.connectionModel
        .findOne({ _id: connId, isDeleted: false })
        .select('+pageAccessTokenEnc');
      if (!conn) throw new NotFoundException(`Facebook connection ${connId} not found`);

      // A future scheduledAt parks the listing for the cron; otherwise honour
      // publishNow (default true) → publish now, else save as draft.
      const scheduledFuture =
        dto.scheduledAt && new Date(dto.scheduledAt).getTime() > Date.now()
          ? new Date(dto.scheduledAt)
          : null;

      const listing = await this.listingModel.create({
        vehicle: new Types.ObjectId(dto.vehicleId),
        vehicleTitle: dto.vehicleTitle ?? dto.title,
        destinationType: dto.destinationType ?? FacebookDestinationType.PAGE,
        connection: conn._id,
        destinationName: conn.pageName,
        title: dto.title,
        description: dto.description ?? '',
        price: dto.price ?? 0,
        photos: dto.photos ?? [],
        location: dto.location ?? '',
        contact: dto.contact ?? '',
        status: scheduledFuture
          ? FacebookListingStatus.SCHEDULED
          : FacebookListingStatus.DRAFT,
        scheduledAt: scheduledFuture ?? undefined,
        createdBy:
          actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
      });
      createdIds.push(listing._id as Types.ObjectId);

      if (!scheduledFuture && dto.publishNow !== false) {
        await this.publishOne(listing, conn, actorId);
      }
    }

    // Group targets — assisted-manual: always created as DRAFTs (Facebook removed
    // the Groups publishing API, so there's no auto-post). The user pastes the
    // listing into the group themselves, then marks it posted.
    for (const gid of dto.groupTargetIds ?? []) {
      if (!isValidObjectId(gid)) continue;
      const group = await this.groupTargetModel.findOne({ _id: gid, isDeleted: false });
      if (!group) throw new NotFoundException(`Facebook group ${gid} not found`);
      const listing = await this.listingModel.create({
        vehicle: new Types.ObjectId(dto.vehicleId),
        vehicleTitle: dto.vehicleTitle ?? dto.title,
        destinationType: FacebookDestinationType.GROUP_MANUAL,
        groupTarget: group._id,
        destinationName: group.name,
        destinationUrl: group.groupUrl,
        title: dto.title,
        description: dto.description ?? '',
        price: dto.price ?? 0,
        photos: dto.photos ?? [],
        location: dto.location ?? '',
        contact: dto.contact ?? '',
        status: FacebookListingStatus.DRAFT,
        createdBy: actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
      });
      createdIds.push(listing._id as Types.ObjectId);
    }

    const docs = await this.listingModel
      .find({ _id: { $in: createdIds } })
      .sort({ createdAt: -1 })
      .lean();
    return docs as unknown as FacebookListingDocument[];
  }

  /** Publish a draft / retry a failed listing. */
  async publishListing(id: string, actorId?: string): Promise<FacebookListingDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Listing not found');
    const listing = await this.listingModel.findOne({ _id: id, isDeleted: false });
    if (!listing) throw new NotFoundException('Listing not found');
    const conn = await this.connectionModel
      .findOne({ _id: listing.connection, isDeleted: false })
      .select('+pageAccessTokenEnc');
    if (!conn) throw new NotFoundException('Target Facebook Page is no longer connected');
    // Route by destination type — a marketplace_catalog listing must sync to the
    // catalog (Item API), NOT create a Page post. (doPublish here was the bug
    // that posted Marketplace listings to the Page instead.)
    await this.publishOne(listing, conn, actorId);
    return (await this.listingModel.findById(id)) as FacebookListingDocument;
  }

  /** Remove (unpublish) a listing: delete the FB post (best-effort) + soft-delete. */
  async removeListing(id: string, actorId?: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Listing not found');
    const listing = await this.listingModel.findOne({ _id: id, isDeleted: false });
    if (!listing) throw new NotFoundException('Listing not found');

    if (listing.fbPostId) {
      try {
        const conn = await this.connectionModel
          .findOne({ _id: listing.connection })
          .select('+pageAccessTokenEnc +catalogAccessTokenEnc');
        if (listing.destinationType === FacebookDestinationType.MARKETPLACE_CATALOG) {
          // Catalog deletes use the catalog token (not the Page token), same as writes.
          const catToken = conn?.catalogAccessTokenEnc
            ? decryptToken(conn.catalogAccessTokenEnc)
            : '';
          if (catToken) {
            await this.fb.deleteCatalogItem(conn.catalogId, catToken, listing.fbPostId);
          }
        } else if (conn?.pageAccessTokenEnc) {
          await this.fb.deletePagePost(decryptToken(conn.pageAccessTokenEnc), listing.fbPostId);
        }
      } catch (err) {
        // Best-effort — the post may already be gone Facebook-side. We still
        // remove our row so the dealer's view reflects their intent.
        this.logger.warn(
          `Could not delete FB post ${listing.fbPostId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.listingModel.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          status: FacebookListingStatus.REMOVED,
        },
      },
    );
    await this.activity.log({
      module: 'facebook',
      action: 'listing-removed',
      entity: 'Listing',
      entityId: id,
      label: `${listing.title} — ${listing.destinationName}`,
      byId: actorId,
      meta: { destination: listing.destinationName },
    });
  }

  /** Compose the post text from the snapshotted listing fields. */
  private composeMessage(listing: FacebookListingDocument): string {
    const parts: string[] = [listing.title];
    if (listing.description) parts.push(listing.description);
    if (listing.price) parts.push(`Price: $${Number(listing.price).toLocaleString()}`);
    if (listing.location) parts.push(`Location: ${listing.location}`);
    if (listing.contact) parts.push(`Contact: ${listing.contact}`);
    return parts.join('\n\n');
  }

  /** Shared publish step: call Graph (or the dev-mock), then stamp the result. */
  private async doPublish(
    listing: FacebookListingDocument,
    conn: FacebookConnectionDocument,
    actorId?: string,
  ): Promise<void> {
    try {
      const token = conn.pageAccessTokenEnc ? decryptToken(conn.pageAccessTokenEnc) : '';
      const { postId, permalink } = await this.fb.publishToPage(conn.pageId, token, {
        message: this.composeMessage(listing),
        imageUrls: listing.photos ?? [],
      });
      await this.listingModel.updateOne(
        { _id: listing._id },
        {
          $set: {
            status: FacebookListingStatus.ACTIVE,
            fbPostId: postId,
            fbPermalink: permalink,
            publishedAt: new Date(),
            lastError: '',
          },
        },
      );
      await this.activity.log({
        module: 'facebook',
        action: 'published',
        entity: 'Listing',
        entityId: String(listing._id),
        label: `${listing.title} → ${conn.pageName}`,
        byId: actorId,
        meta: { pageId: conn.pageId },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.listingModel.updateOne(
        { _id: listing._id },
        { $set: { status: FacebookListingStatus.FAILED, lastError: msg } },
      );
      this.logger.warn(`Publish failed for listing ${listing._id}: ${msg}`);
    }
  }

  /** Route a listing to the right publisher based on its destination type. */
  private async publishOne(
    listing: FacebookListingDocument,
    conn: FacebookConnectionDocument,
    actorId?: string,
  ): Promise<void> {
    if (listing.destinationType === FacebookDestinationType.MARKETPLACE_CATALOG) {
      await this.doSyncCatalog(listing, conn, actorId);
    } else {
      await this.doPublish(listing, conn, actorId);
    }
  }

  /**
   * Sync a listing into the Page's product catalog (Marketplace). Enriches the
   * catalog item from the real vehicle (make/model/year/mileage). Eligibility:
   * the connection must have a catalogId and the vehicle must have mileage
   * (Marketplace requires used/CPO + >500 mi). Dev-mode mints a mock item id.
   * Real-mode also needs publicly-reachable image URLs (S3 prerequisite).
   */
  private async doSyncCatalog(
    listing: FacebookListingDocument,
    conn: FacebookConnectionDocument,
    actorId?: string,
  ): Promise<void> {
    try {
      if (!conn.catalogId) {
        throw new Error('This Facebook connection has no product catalog configured');
      }
      const vehicle: any = await this.vehicleModel.findOne({ _id: listing.vehicle }).lean();
      const km = vehicle?.km ?? 0;
      if (!km) {
        throw new Error('Marketplace requires the vehicle mileage to be set (used vehicles only)');
      }
      // Catalog writes need a `catalog_management` token (a Business System User
      // token) — the Page token can't write to a product catalog (Graph code
      // 100/33). It's stored select:false, so re-fetch it explicitly.
      const catConn = await this.connectionModel
        .findOne({ _id: conn._id })
        .select('+catalogAccessTokenEnc');
      const token = catConn?.catalogAccessTokenEnc
        ? decryptToken(catConn.catalogAccessTokenEnc)
        : '';
      if (!token) {
        throw new Error(
          'No catalog access token set for this Page. On the Destinations tab, add a System ' +
            'User token with catalog_management — a Page token cannot write to a product catalog.',
        );
      }
      const retailerId = String(listing._id);
      // A Vehicles catalog item has more REQUIRED fields than a Page post: a
      // public `url`, `exterior_color`, a structured `address`, and a publicly-
      // reachable image. Missing any of these is accepted by items_batch (200)
      // but the item is rejected by Facebook's async validation (shows under
      // Commerce Manager → Issues) and never appears in the catalog.
      const settings: any = await this.settingsModel.findOne().lean();
      const currency = (settings?.currency || 'USD').toUpperCase();
      const address = {
        addr1: settings?.address || listing.location || 'N/A',
        city: settings?.city || '',
        region: settings?.state || '',
        postal_code: settings?.zipCode || '',
        // Facebook expects an ISO-3166 alpha-2 code; default to US.
        country: (settings?.country || 'US').slice(0, 2).toUpperCase(),
      };
      // Facebook fetches the image over the internet — only an absolute http(s)
      // URL works (a local /uploads path won't resolve; needs the S3 upload).
      const imageUrl = (listing.photos ?? []).find(
        (p: any) => typeof p === 'string' && /^https?:\/\//i.test(p),
      );
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const url = base ? `${base}/website/inventory/${String(listing.vehicle)}` : '';
      const item: Record<string, any> = {
        id: retailerId,
        title: (listing.title || '').slice(0, 200),
        description: listing.description || listing.title,
        url,
        availability: 'in stock',
        condition: 'used',
        state_of_vehicle: 'USED',
        price: `${Math.round(listing.price || 0)} ${currency}`,
        ...(imageUrl ? { image_url: imageUrl } : {}),
        make: vehicle?.company,
        model: vehicle?.model,
        year: vehicle?.year,
        mileage: { value: km, unit: 'KM' },
        exterior_color: vehicle?.color || 'Unknown',
        ...(vehicle?.vin ? { vin: vehicle.vin } : {}),
        address,
        vehicle_id: vehicle?.vehicleNumber || retailerId,
      };
      const { retailerId: syncedId } = await this.fb.syncCatalogItem(
        conn.catalogId,
        token,
        item,
        'CREATE',
      );
      await this.listingModel.updateOne(
        { _id: listing._id },
        {
          $set: {
            status: FacebookListingStatus.ACTIVE,
            fbPostId: syncedId,
            fbPermalink: `https://www.facebook.com/marketplace/item/${syncedId}`,
            publishedAt: new Date(),
            lastError: '',
          },
        },
      );
      await this.activity.log({
        module: 'facebook',
        action: 'published',
        entity: 'Listing',
        entityId: String(listing._id),
        label: `${listing.title} → Marketplace`,
        byId: actorId,
        meta: { catalogId: conn.catalogId },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.listingModel.updateOne(
        { _id: listing._id },
        { $set: { status: FacebookListingStatus.FAILED, lastError: msg } },
      );
      this.logger.warn(`Catalog sync failed for listing ${listing._id}: ${msg}`);
    }
  }

  // ── Group targets + assisted-manual posting (Phase 5) ────────────────────

  async listGroupTargets(): Promise<FacebookGroupTargetDocument[]> {
    const docs = await this.groupTargetModel
      .find({ isDeleted: false })
      .sort({ category: 1, createdAt: -1 })
      .lean();
    return docs as unknown as FacebookGroupTargetDocument[];
  }

  async createGroupTarget(
    dto: CreateGroupTargetDto,
    actorId?: string,
  ): Promise<FacebookGroupTargetDocument> {
    return this.groupTargetModel.create({
      name: dto.name,
      groupUrl: dto.groupUrl,
      category: dto.category ?? '',
      notes: dto.notes ?? '',
      createdBy: actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
    });
  }

  async deleteGroupTarget(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Group not found');
    const res = await this.groupTargetModel.updateOne(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
    if (!res.matchedCount) throw new NotFoundException('Group not found');
  }

  /** Mark a group-manual listing as posted (after the user pasted it into the
   *  group). Stamps it active + records the pasted permalink. */
  async markPosted(
    id: string,
    permalink?: string,
    actorId?: string,
  ): Promise<FacebookListingDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Listing not found');
    const listing = await this.listingModel.findOne({ _id: id, isDeleted: false });
    if (!listing) throw new NotFoundException('Listing not found');
    await this.listingModel.updateOne(
      { _id: id },
      {
        $set: {
          status: FacebookListingStatus.ACTIVE,
          fbPermalink: permalink || listing.fbPermalink || '',
          publishedAt: new Date(),
        },
      },
    );
    await this.activity.log({
      module: 'facebook',
      action: 'group-posted',
      entity: 'Listing',
      entityId: id,
      label: `${listing.title} — ${listing.destinationName}`,
      byId: actorId,
    });
    return (await this.listingModel.findById(id)) as FacebookListingDocument;
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates(): Promise<FacebookListingTemplateDocument[]> {
    const docs = await this.templateModel
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();
    return docs as unknown as FacebookListingTemplateDocument[];
  }

  async createTemplate(
    dto: CreateTemplateDto,
    actorId?: string,
  ): Promise<FacebookListingTemplateDocument> {
    return this.templateModel.create({
      name: dto.name,
      titleTemplate: dto.titleTemplate ?? '',
      descriptionTemplate: dto.descriptionTemplate ?? '',
      defaultLocation: dto.defaultLocation ?? '',
      defaultContact: dto.defaultContact ?? '',
      createdBy:
        actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Template not found');
    const res = await this.templateModel.updateOne(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
    if (!res.matchedCount) throw new NotFoundException('Template not found');
  }

  // ── Edit / duplicate ────────────────────────────────────────────────────────

  /**
   * Edit listing content. If the listing is already published (active) we also
   * best-effort sync the post text on Facebook — photos can't be edited
   * post-publish (that's a remove + re-publish), only the message.
   */
  async updateListing(
    id: string,
    dto: UpdateListingDto,
    actorId?: string,
  ): Promise<FacebookListingDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Listing not found');
    const listing = await this.listingModel.findOne({ _id: id, isDeleted: false });
    if (!listing) throw new NotFoundException('Listing not found');

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.description !== undefined) set.description = dto.description;
    if (dto.price !== undefined) set.price = dto.price;
    if (dto.photos !== undefined) set.photos = dto.photos;
    if (dto.location !== undefined) set.location = dto.location;
    if (dto.contact !== undefined) set.contact = dto.contact;
    if (dto.scheduledAt !== undefined) {
      const when = new Date(dto.scheduledAt);
      set.scheduledAt = when;
      // Re-arm a draft for the cron if the new time is in the future.
      if (listing.status === FacebookListingStatus.DRAFT && when.getTime() > Date.now()) {
        set.status = FacebookListingStatus.SCHEDULED;
      }
    }
    await this.listingModel.updateOne({ _id: id }, { $set: set });
    const updated = (await this.listingModel.findById(id)) as FacebookListingDocument;

    if (updated.status === FacebookListingStatus.ACTIVE && updated.fbPostId) {
      try {
        const conn = await this.connectionModel
          .findOne({ _id: updated.connection })
          .select('+pageAccessTokenEnc');
        if (conn?.pageAccessTokenEnc) {
          await this.fb.updatePagePost(
            decryptToken(conn.pageAccessTokenEnc),
            updated.fbPostId,
            this.composeMessage(updated),
          );
        }
      } catch (err) {
        this.logger.warn(
          `Could not sync edited post ${updated.fbPostId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.activity.log({
      module: 'facebook',
      action: 'updated',
      entity: 'Listing',
      entityId: id,
      label: `${updated.title} — ${updated.destinationName}`,
      byId: actorId,
    });
    return updated;
  }

  /** Clone a listing's content into a fresh DRAFT (no Facebook post yet). */
  async duplicateListing(id: string, actorId?: string): Promise<FacebookListingDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Listing not found');
    const src = await this.listingModel.findOne({ _id: id, isDeleted: false });
    if (!src) throw new NotFoundException('Listing not found');
    return this.listingModel.create({
      vehicle: src.vehicle,
      vehicleTitle: src.vehicleTitle,
      destinationType: src.destinationType,
      connection: src.connection,
      destinationName: src.destinationName,
      title: `${src.title} (copy)`,
      description: src.description,
      price: src.price,
      photos: src.photos,
      location: src.location,
      contact: src.contact,
      status: FacebookListingStatus.DRAFT,
      createdBy:
        actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
    });
  }

  // ── Scheduled-publish cron ───────────────────────────────────────────────────

  /**
   * Publish any scheduled listing whose time has arrived. Runs every minute;
   * the status + scheduledAt query is cheap and indexed. Best-effort — a
   * failure marks that row `failed` (via doPublish) and the next tick moves on.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async publishDueScheduled(): Promise<void> {
    let due: FacebookListingDocument[];
    try {
      due = await this.listingModel.find({
        status: FacebookListingStatus.SCHEDULED,
        isDeleted: false,
        scheduledAt: { $lte: new Date() },
      });
    } catch (err) {
      this.logger.error(
        'Scheduled-publish query failed',
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }
    if (!due.length) return;
    for (const listing of due) {
      const conn = await this.connectionModel
        .findOne({ _id: listing.connection, isDeleted: false })
        .select('+pageAccessTokenEnc');
      if (!conn) {
        await this.listingModel.updateOne(
          { _id: listing._id },
          {
            $set: {
              status: FacebookListingStatus.FAILED,
              lastError: 'Target Page is no longer connected',
            },
          },
        );
        continue;
      }
      await this.publishOne(listing, conn);
    }
    this.logger.log(`Published ${due.length} scheduled listing(s)`);
  }

  // ── Engagement + comments (Phase 2) ──────────────────────────────────────

  /**
   * Refresh engagement counts + pull comments for active listings (all, or one
   * by id). Updates `listing.engagement` and upserts comments idempotently by
   * `fbCommentId`. Best-effort per listing.
   */
  async syncEngagement(listingId?: string): Promise<void> {
    const filter: any = {
      isDeleted: false,
      status: FacebookListingStatus.ACTIVE,
      fbPostId: { $ne: '' },
    };
    if (listingId && isValidObjectId(listingId)) filter._id = new Types.ObjectId(listingId);

    const listings = await this.listingModel.find(filter);
    for (const listing of listings) {
      const conn = await this.connectionModel
        .findOne({ _id: listing.connection })
        .select('+pageAccessTokenEnc');
      if (!conn?.pageAccessTokenEnc) continue;
      const token = decryptToken(conn.pageAccessTokenEnc);
      try {
        const insights = await this.fb.fetchPostInsights(token, listing.fbPostId);
        await this.listingModel.updateOne(
          { _id: listing._id },
          { $set: { engagement: { ...insights, fetchedAt: new Date() } } },
        );
        // Append-only snapshot for the Analytics trend chart.
        await this.engagementModel.create({
          listing: listing._id,
          reactions: insights.reactions,
          comments: insights.comments,
          shares: insights.shares,
          views: insights.views,
          fetchedAt: new Date(),
        });
      } catch (err) {
        this.logger.warn(
          `Engagement (insights) sync failed for listing ${listing._id}: ${err instanceof Error ? err.message : err}`,
        );
      }
      // Comment ingestion is a SEPARATE concern with a SEPARATE permission
      // (reading users' comment content needs `pages_read_user_content`, not
      // just `pages_read_engagement`). Isolate it so a comment-read failure
      // doesn't mask a successful insights refresh — and so the real Graph
      // error surfaces (instead of an empty unread badge with no explanation).
      try {
        const comments = await this.fb.fetchPostComments(token, listing.fbPostId);
        for (const c of comments) await this.upsertComment(listing, c);
      } catch (err) {
        this.logger.warn(
          `Comment sync failed for listing ${listing._id} — the Page token may be missing the ` +
            `'pages_read_user_content' permission (reconnect the Page after granting it): ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Insert a comment if new (idempotent by fbCommentId); refresh its text if
   *  the author edited it. Never clobbers an existing reply/resolve status. */
  private async upsertComment(
    listing: FacebookListingDocument,
    c: { id: string; authorName: string; authorId: string; message: string; createdTime?: string },
  ): Promise<void> {
    const existing = await this.commentModel.findOne({ fbCommentId: c.id });
    if (existing) {
      if (existing.message !== c.message) {
        await this.commentModel.updateOne({ _id: existing._id }, { $set: { message: c.message } });
      }
      return;
    }
    await this.commentModel.create({
      listing: listing._id,
      connection: listing.connection,
      fbCommentId: c.id,
      fbPostId: listing.fbPostId,
      authorName: c.authorName,
      authorId: c.authorId,
      message: c.message,
      fbCreatedTime: c.createdTime ? new Date(c.createdTime) : new Date(),
      status: FacebookCommentStatus.NEW,
    });
  }

  async listComments(
    filters: { listingId?: string; status?: string } = {},
  ): Promise<FacebookCommentDocument[]> {
    const query: any = { isDeleted: false };
    if (filters.status) query.status = filters.status;
    if (filters.listingId && isValidObjectId(filters.listingId)) {
      query.listing = new Types.ObjectId(filters.listingId);
    }
    const docs = await this.commentModel.find(query).sort({ fbCreatedTime: -1 }).lean();
    return docs as unknown as FacebookCommentDocument[];
  }

  /** Mark all of a listing's comments as read (seen). Idempotent. `$ne: false`
   *  also catches comments predating the `unread` field. */
  async markCommentsRead(listingId: string): Promise<void> {
    if (!isValidObjectId(listingId)) return;
    await this.commentModel.updateMany(
      { listing: new Types.ObjectId(listingId), unread: { $ne: false }, isDeleted: false },
      { $set: { unread: false } },
    );
  }

  /** Totals for the sidebar nav badge: unread message threads + unread comments. */
  async getUnreadCount(): Promise<{ messages: number; comments: number; total: number }> {
    const [messages, comments] = await Promise.all([
      this.conversationModel.countDocuments({ isDeleted: false, unread: true }),
      this.commentModel.countDocuments({ isDeleted: false, unread: { $ne: false } }),
    ]);
    return { messages, comments, total: messages + comments };
  }

  /** Reply to a comment on Facebook, then stamp the row replied. If the Graph
   *  call fails (real-mode) it throws so the UI surfaces it — the row stays new. */
  async replyComment(
    id: string,
    message: string,
    actorId?: string,
  ): Promise<FacebookCommentDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Comment not found');
    const comment = await this.commentModel.findOne({ _id: id, isDeleted: false });
    if (!comment) throw new NotFoundException('Comment not found');
    const conn = await this.connectionModel
      .findOne({ _id: comment.connection })
      .select('+pageAccessTokenEnc');
    const token = conn?.pageAccessTokenEnc ? decryptToken(conn.pageAccessTokenEnc) : '';

    await this.fb.replyToComment(token, comment.fbCommentId, message);
    await this.commentModel.updateOne(
      { _id: id },
      {
        $set: {
          status: FacebookCommentStatus.REPLIED,
          replyText: message,
          repliedBy:
            actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
          repliedAt: new Date(),
          // Replying means you've seen it — clear unread so a replied comment
          // never lingers in the "New"/unread counts.
          unread: false,
        },
      },
    );
    await this.activity.log({
      module: 'facebook',
      action: 'comment-replied',
      entity: 'Comment',
      entityId: id,
      label: `Replied to ${comment.authorName}`,
      byId: actorId,
    });
    return (await this.commentModel.findById(id)) as FacebookCommentDocument;
  }

  async resolveComment(id: string, actorId?: string): Promise<FacebookCommentDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Comment not found');
    const res = await this.commentModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { status: FacebookCommentStatus.RESOLVED } },
      { new: true },
    );
    if (!res) throw new NotFoundException('Comment not found');
    await this.activity.log({
      module: 'facebook',
      action: 'comment-resolved',
      entity: 'Comment',
      entityId: id,
      label: `Resolved comment from ${res.authorName}`,
      byId: actorId,
    });
    return res;
  }

  // ── Analytics (Phase 6) ──────────────────────────────────────────────────

  /** Summary KPIs + best-performing listings + a 30-day engagement trend (from
   *  the append-only snapshots) + the follow-up queue (new comments / unread
   *  conversations). */
  async getAnalytics(): Promise<any> {
    const active = await this.listingModel
      .find({ isDeleted: false, status: FacebookListingStatus.ACTIVE })
      .lean();

    let reactions = 0;
    let comments = 0;
    let shares = 0;
    const scored = active.map((l: any) => {
      const e = l.engagement ?? {};
      reactions += e.reactions ?? 0;
      comments += e.comments ?? 0;
      shares += e.shares ?? 0;
      return {
        id: String(l._id),
        title: l.title,
        destinationName: l.destinationName,
        reactions: e.reactions ?? 0,
        comments: e.comments ?? 0,
        shares: e.shares ?? 0,
        score: (e.reactions ?? 0) + (e.comments ?? 0) + (e.shares ?? 0),
      };
    });
    const topListings = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trendAgg = await this.engagementModel.aggregate([
      { $match: { fetchedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$fetchedAt' } },
          reactions: { $sum: '$reactions' },
          comments: { $sum: '$comments' },
          shares: { $sum: '$shares' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const trend = trendAgg.map((t: any) => ({
      date: t._id,
      reactions: t.reactions,
      comments: t.comments,
      shares: t.shares,
    }));

    const newComments = await this.commentModel.countDocuments({
      isDeleted: false,
      status: FacebookCommentStatus.NEW,
    });
    const unreadConversations = await this.conversationModel.countDocuments({
      isDeleted: false,
      unread: true,
    });

    return {
      summary: {
        activeListings: active.length,
        reactions,
        comments,
        shares,
        newComments,
        unreadConversations,
      },
      topListings,
      trend,
      followUp: { newComments, unreadConversations },
    };
  }

  /** Periodic engagement + comment refresh for active listings. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncAllEngagement(): Promise<void> {
    try {
      await this.syncEngagement();
    } catch (err) {
      this.logger.error(
        'Engagement sync cron failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // ── Messenger conversations + lead pipeline (Phase 3) ────────────────────

  /** Pull Messenger threads + their messages for active connections (all, or
   *  one). Upserts conversations (preserving leadStatus/assignee) + messages. */
  async syncConversations(connectionId?: string): Promise<void> {
    const filter: any = { isDeleted: false, status: FacebookConnectionStatus.ACTIVE };
    if (connectionId && isValidObjectId(connectionId)) filter._id = new Types.ObjectId(connectionId);
    const conns = await this.connectionModel.find(filter).select('+pageAccessTokenEnc');
    for (const conn of conns) {
      if (!conn.pageAccessTokenEnc) continue;
      const token = decryptToken(conn.pageAccessTokenEnc);
      try {
        const convs = await this.fb.fetchConversations(conn.pageId, token);
        for (const c of convs) {
          const convDoc = await this.upsertConversation(conn, c);
          const msgs = await this.fb.fetchMessages(token, c.id);
          await this.ingestMessages(convDoc, msgs);
        }
      } catch (err) {
        this.logger.warn(
          `Conversation sync failed for connection ${conn._id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async upsertConversation(
    conn: FacebookConnectionDocument,
    c: {
      id: string;
      participantName: string;
      participantId: string;
      snippet: string;
      updatedTime?: string;
      unreadCount: number;
    },
  ): Promise<FacebookConversationDocument> {
    const existing = await this.conversationModel.findOne({ fbConversationId: c.id });
    if (existing) {
      await this.conversationModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            snippet: c.snippet || existing.snippet,
            participantName: c.participantName || existing.participantName,
            ...(c.updatedTime ? { lastMessageAt: new Date(c.updatedTime) } : {}),
          },
        },
      );
      return (await this.conversationModel.findById(existing._id)) as FacebookConversationDocument;
    }
    return this.conversationModel.create({
      connection: conn._id,
      fbConversationId: c.id,
      participantName: c.participantName,
      participantId: c.participantId,
      snippet: c.snippet ?? '',
      leadStatus: FacebookLeadStatus.NEW,
      lastMessageAt: c.updatedTime ? new Date(c.updatedTime) : new Date(),
      unread: (c.unreadCount ?? 0) > 0,
    });
  }

  private async ingestMessages(
    conv: FacebookConversationDocument,
    msgs: Array<{ id: string; fromId: string; fromName: string; text: string; createdTime?: string }>,
  ): Promise<void> {
    let latestInbound: Date | undefined;
    let lastAt: Date | undefined;
    let lastText = '';
    let newInbound = false;
    for (const m of msgs) {
      const createdAt = m.createdTime ? new Date(m.createdTime) : new Date();
      const direction =
        m.fromId === conv.participantId
          ? FacebookMessageDirection.IN
          : FacebookMessageDirection.OUT;
      const existing = await this.messageModel.findOne({ fbMessageId: m.id });
      if (!existing) {
        await this.messageModel.create({
          conversation: conv._id,
          fbMessageId: m.id,
          direction,
          text: m.text ?? '',
          fbCreatedTime: createdAt,
        });
        if (direction === FacebookMessageDirection.IN) newInbound = true;
      }
      if (direction === FacebookMessageDirection.IN && (!latestInbound || createdAt > latestInbound)) {
        latestInbound = createdAt;
      }
      if (!lastAt || createdAt >= lastAt) {
        lastAt = createdAt;
        lastText = m.text || lastText;
      }
    }
    const set: any = {};
    if (latestInbound) set.lastInboundAt = latestInbound;
    if (lastAt) set.lastMessageAt = lastAt;
    if (lastText) set.snippet = lastText.slice(0, 200);
    if (newInbound) set.unread = true;
    if (Object.keys(set).length) {
      await this.conversationModel.updateOne({ _id: conv._id }, { $set: set });
    }
  }

  async listConversations(
    filters: { leadStatus?: string; assignedTo?: string } = {},
  ): Promise<FacebookConversationDocument[]> {
    const query: any = { isDeleted: false };
    if (filters.leadStatus) query.leadStatus = filters.leadStatus;
    if (filters.assignedTo && isValidObjectId(filters.assignedTo)) {
      query.assignedTo = new Types.ObjectId(filters.assignedTo);
    }
    const docs = await this.conversationModel.find(query).sort({ lastMessageAt: -1 }).lean();
    return docs as unknown as FacebookConversationDocument[];
  }

  /** Messages in a thread (ascending). Opening the thread marks it read. */
  async getConversationMessages(convId: string): Promise<FacebookMessageDocument[]> {
    if (!isValidObjectId(convId)) throw new NotFoundException('Conversation not found');
    const conv = await this.conversationModel.findOne({ _id: convId, isDeleted: false });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.unread) {
      await this.conversationModel.updateOne({ _id: convId }, { $set: { unread: false } });
    }
    const msgs = await this.messageModel
      .find({ conversation: convId, isDeleted: false })
      .sort({ fbCreatedTime: 1 })
      .lean();
    return msgs as unknown as FacebookMessageDocument[];
  }

  /** Send a Messenger reply (Send API). Throws in real-mode if the 24h window is
   *  closed (Facebook rejects it) — the UI surfaces that. */
  async sendReply(
    convId: string,
    text: string,
    actorId?: string,
    actorName?: string,
  ): Promise<FacebookMessageDocument> {
    if (!isValidObjectId(convId)) throw new NotFoundException('Conversation not found');
    const conv = await this.conversationModel.findOne({ _id: convId, isDeleted: false });
    if (!conv) throw new NotFoundException('Conversation not found');
    const connection = await this.connectionModel
      .findOne({ _id: conv.connection })
      .select('+pageAccessTokenEnc');
    const token = connection?.pageAccessTokenEnc ? decryptToken(connection.pageAccessTokenEnc) : '';
    const pageId = connection?.pageId ?? '';

    const sent = await this.fb.sendMessage(pageId, token, conv.participantId, text);
    const msg = await this.messageModel.create({
      conversation: conv._id,
      fbMessageId: sent.id || `out-${Date.now()}`,
      direction: FacebookMessageDirection.OUT,
      text,
      sentByStaff: actorId && isValidObjectId(actorId) ? new Types.ObjectId(actorId) : undefined,
      sentByName: actorName ?? '',
      fbCreatedTime: new Date(),
    });
    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $set: { lastMessageAt: new Date(), snippet: text.slice(0, 200) } },
    );
    await this.activity.log({
      module: 'facebook',
      action: 'message-sent',
      entity: 'Conversation',
      entityId: convId,
      label: `Replied to ${conv.participantName}`,
      byId: actorId,
    });
    return msg;
  }

  /** Assign a conversation and/or move its lead-pipeline status. */
  async updateConversation(
    convId: string,
    dto: UpdateConversationDto,
    actorId?: string,
  ): Promise<FacebookConversationDocument> {
    if (!isValidObjectId(convId)) throw new NotFoundException('Conversation not found');
    const conv = await this.conversationModel.findOne({ _id: convId, isDeleted: false });
    if (!conv) throw new NotFoundException('Conversation not found');

    const set: any = {};
    let assigned = false;
    let statusChanged = false;
    if (dto.assignedTo !== undefined) {
      set.assignedTo =
        dto.assignedTo && isValidObjectId(dto.assignedTo)
          ? new Types.ObjectId(dto.assignedTo)
          : null;
      set.assignedToName = dto.assignedToName ?? '';
      assigned = true;
    }
    if (dto.leadStatus !== undefined) {
      set.leadStatus = dto.leadStatus;
      statusChanged = true;
    }
    await this.conversationModel.updateOne({ _id: convId }, { $set: set });

    if (assigned) {
      await this.activity.log({
        module: 'facebook',
        action: 'lead-assigned',
        entity: 'Conversation',
        entityId: convId,
        label: `Assigned ${conv.participantName} to ${dto.assignedToName || 'unassigned'}`,
        byId: actorId,
      });
    }
    if (statusChanged) {
      await this.activity.log({
        module: 'facebook',
        action: 'lead-status-changed',
        entity: 'Conversation',
        entityId: convId,
        label: `${conv.participantName} → ${dto.leadStatus}`,
        byId: actorId,
      });
    }
    return (await this.conversationModel.findById(convId)) as FacebookConversationDocument;
  }

  /**
   * Promote a Messenger conversation into a real CDMS Lead: create a CRM
   * BuyerLead from the supplied contact details, then a Lead (buyer × vehicle)
   * via LeadsService — which enforces Guard 1 (no lead on a sold vehicle) and
   * Guard 2 (no duplicate non-archived buyer×vehicle). Links the new Lead back
   * onto the conversation. Cross-module create stays in LeadsService so the
   * guards live in one place.
   */
  async promoteToLead(
    convId: string,
    dto: PromoteLeadDto,
    actorId?: string,
  ): Promise<FacebookConversationDocument> {
    if (!isValidObjectId(convId)) throw new NotFoundException('Conversation not found');
    const conv = await this.conversationModel.findOne({ _id: convId, isDeleted: false });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.lead) throw new ConflictException('This conversation is already linked to a lead');

    // 1. CRM buyer from the supplied details.
    const buyer = await this.crmBuyers.create({
      buyerName: dto.buyerName,
      buyerEmail: dto.buyerEmail,
      buyerPhone: dto.buyerPhone,
      interestedVehicles: [dto.vehicleId],
      stage: BuyerLeadStage.NEW,
    });

    // 2. Lead (buyer × vehicle) — guards enforced inside LeadsService.create.
    //    A ConflictException (sold vehicle / duplicate) propagates to the UI.
    const lead = await this.leadsService.create(
      {
        buyer: String(buyer._id),
        vehicle: dto.vehicleId,
        source: LeadSource.META_ADS,
        status: LeadStatus.NEW,
        assignedTo: conv.assignedTo ? String(conv.assignedTo) : undefined,
        notes: dto.notes || `Promoted from Facebook Messenger — ${conv.participantName}`,
      },
      actorId ?? '',
    );

    // 3. Link + log.
    await this.conversationModel.updateOne(
      { _id: convId },
      { $set: { lead: new Types.ObjectId(String(lead._id)) } },
    );
    await this.activity.log({
      module: 'facebook',
      action: 'lead-promoted',
      entity: 'Conversation',
      entityId: convId,
      label: `${conv.participantName} → CDMS Lead`,
      byId: actorId,
      meta: { leadId: String(lead._id), vehicleId: dto.vehicleId },
    });
    return (await this.conversationModel.findById(convId)) as FacebookConversationDocument;
  }

  /** Periodic Messenger conversation + message refresh for active connections. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncAllConversations(): Promise<void> {
    try {
      await this.syncConversations();
    } catch (err) {
      this.logger.error(
        'Conversation sync cron failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
