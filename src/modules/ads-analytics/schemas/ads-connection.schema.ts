import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type AdsConnectionDocument = AdsConnection & Document;

export enum AdsProvider {
  GOOGLE = 'google',
  META = 'meta',
}

export enum AdsConnectionStatus {
  /** OAuth done but no ad account bound yet (multi-account picker pending). */
  PENDING_ACCOUNT = 'pending_account',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

/**
 * A connected ad-platform account (Google Ads or Meta Ads) for read-only
 * analytics. Single-tenant: no dealershipId. Keyed one row per `provider`
 * (re-connecting refreshes the token rather than duplicating); the bound ad
 * account is `accountId` and can be switched without re-auth.
 *
 * Tokens are AES-256-GCM encrypted at rest (common/crypto/token-cipher.ts,
 * `*Enc` + select:false) — reversible by design because we must replay them to
 * call the ad APIs, exactly like the Facebook Page token. We only ever request
 * READ scopes (Google `adwords` reporting, Meta `ads_read`).
 */
@Schema({ timestamps: true, collection: 'ads_connections' })
export class AdsConnection {
  @Prop({ type: String, enum: AdsProvider, required: true, index: true })
  provider: AdsProvider;

  /** Google: digits-only customer id (e.g. 6765726290). Meta: `act_<id>`. */
  @Prop({ default: '' }) accountId: string;
  @Prop({ default: '' }) accountName: string;
  @Prop({ default: '' }) currency: string;

  /** Google Manager (MCC) id used as `login-customer-id`. Empty for Meta. */
  @Prop({ default: '' }) loginCustomerId: string;

  @Prop({ type: [String], default: [] }) scopes: string[];

  // Meta long-lived USER access token (AES-256-GCM, select:false).
  @Prop({ default: '', select: false }) accessTokenEnc: string;
  // Google refresh token (AES-256-GCM, select:false). We mint short-lived
  // access tokens from it on demand.
  @Prop({ default: '', select: false }) refreshTokenEnc: string;

  @Prop() tokenExpiresAt: Date;
  @Prop() lastSyncedAt: Date;
  /** Last sync error (e.g. DEVELOPER_TOKEN_NOT_APPROVED), surfaced to the UI. */
  @Prop({ default: '' }) lastError: string;

  @Prop({
    type: String,
    enum: AdsConnectionStatus,
    default: AdsConnectionStatus.PENDING_ACCOUNT,
  })
  status: AdsConnectionStatus;

  // Schema.Types.ObjectId — the runtime class (Types.ObjectId) silently
  // degrades to Mixed and stops casting (PROJECT_MEMORY.md §3).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) connectedBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const AdsConnectionSchema = SchemaFactory.createForClass(AdsConnection);

AdsConnectionSchema.index({ provider: 1, isDeleted: 1 });
