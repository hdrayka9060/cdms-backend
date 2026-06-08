import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookConnectionDocument = FacebookConnection & Document;

export enum FacebookConnectionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

/**
 * A connected Facebook destination — one Page the dealership manages. Created
 * by the OAuth connect flow (FacebookService.completeConnect); a Page can be
 * published to and have its comments / Messenger threads worked in CDMS in
 * later phases.
 *
 * Single-tenant: there is no dealershipId — every connection belongs to this
 * one deployment. Multiple Pages are supported (US / Canada / brand Pages).
 */
@Schema({ timestamps: true, collection: 'facebook_connections' })
export class FacebookConnection {
  /** The Facebook Page id this connection publishes to / reads from. */
  @Prop({ required: true, index: true }) pageId: string;

  @Prop({ required: true }) pageName: string;

  // Optional Meta Business + product-catalog ids. `catalogId` is used by the
  // Marketplace syndication phase; both stay empty until those features land.
  @Prop({ default: '' }) businessId: string;
  @Prop({ default: '' }) catalogId: string;

  /** Granted permission scopes (snapshot from the OAuth grant). */
  @Prop({ type: [String], default: [] }) scopes: string[];

  // The long-lived Page access token, AES-256-GCM encrypted at rest
  // (see common/crypto/token-cipher.ts). `select: false` so it never leaves
  // the DB layer in a normal query / API response. Reversible by design — we
  // need it in plaintext to call Graph (unlike bcrypt-hashed passwords /
  // refresh tokens, which we only ever compare).
  @Prop({ default: '', select: false }) pageAccessTokenEnc: string;

  // A token with `catalog_management` — a Business **System User** token — used
  // for Marketplace catalog writes (`/{catalog}/items_batch`). The Page token
  // CANNOT write to a product catalog (Graph returns code 100/33), so this is a
  // separate credential. AES-256-GCM encrypted at rest + `select: false`, same
  // as the Page token.
  @Prop({ default: '', select: false }) catalogAccessTokenEnc: string;

  @Prop() tokenExpiresAt: Date;

  @Prop({
    type: String,
    enum: FacebookConnectionStatus,
    default: FacebookConnectionStatus.ACTIVE,
  })
  status: FacebookConnectionStatus;

  // Staff member who connected this account. Schema.Types.ObjectId — the
  // runtime class (`Types.ObjectId`) silently degrades to Mixed and stops
  // casting (PROJECT_MEMORY.md §3).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) connectedBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookConnectionSchema = SchemaFactory.createForClass(FacebookConnection);

FacebookConnectionSchema.index({ status: 1, isDeleted: 1 });
