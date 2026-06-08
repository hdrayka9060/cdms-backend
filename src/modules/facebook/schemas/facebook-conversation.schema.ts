import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookConversationDocument = FacebookConversation & Document;

/** FB lead pipeline (requirement #6) — distinct from the internal Lead enum.
 *  A separate `lead` ref links to a real CDMS Lead once promoted (future). */
export enum FacebookLeadStatus {
  NEW = 'new',
  CONTACTED = 'contacted',
  INTERESTED = 'interested',
  NEGOTIATING = 'negotiating',
  SOLD = 'sold',
  CLOSED = 'closed',
}

/**
 * A Messenger thread between a person and the connected Page (this is also how
 * Marketplace *chat* leads arrive). Messages live in the separate
 * `facebook_messages` collection (history is unbounded — mirrors the messaging
 * module decision). `lastInboundAt` drives the 24-hour reply window.
 */
@Schema({ timestamps: true, collection: 'facebook_conversations' })
export class FacebookConversation {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookConnection' })
  connection: Types.ObjectId;

  @Prop({ required: true, unique: true }) fbConversationId: string;

  @Prop({ default: '' }) participantName: string;
  @Prop({ default: '' }) participantId: string;
  @Prop({ default: '' }) snippet: string;

  // Optional links: which listing the chat is about, and the CDMS Lead it was
  // promoted into (promote-to-Lead bridge is a later increment).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookListing' })
  listing: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Lead' })
  lead: Types.ObjectId;

  // Assignee — Schema.Types.ObjectId (never the runtime class; PROJECT_MEMORY §3).
  // `assignedToName` is a denormalised snapshot so the list renders without a join.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  assignedTo: Types.ObjectId;
  @Prop({ default: '' }) assignedToName: string;

  @Prop({
    type: String,
    enum: FacebookLeadStatus,
    default: FacebookLeadStatus.NEW,
  })
  leadStatus: FacebookLeadStatus;

  @Prop() lastMessageAt: Date;
  /** Timestamp of the most recent INBOUND message — the 24h standard messaging
   *  window is measured from here. */
  @Prop() lastInboundAt: Date;

  @Prop({ default: false }) unread: boolean;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookConversationSchema =
  SchemaFactory.createForClass(FacebookConversation);

FacebookConversationSchema.index({ leadStatus: 1, isDeleted: 1 });
FacebookConversationSchema.index({ assignedTo: 1 });
FacebookConversationSchema.index({ lastMessageAt: -1 });
