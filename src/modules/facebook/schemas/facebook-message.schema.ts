import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookMessageDocument = FacebookMessage & Document;

export enum FacebookMessageDirection {
  IN = 'in', // from the customer
  OUT = 'out', // sent by the dealership
}

/**
 * A single Messenger message. Separate collection (not embedded) so thread
 * history is unbounded — mirrors the `messaging` module's messages collection.
 */
@Schema({ timestamps: true, collection: 'facebook_messages' })
export class FacebookMessage {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookConversation', required: true })
  conversation: Types.ObjectId;

  @Prop({ required: true, unique: true }) fbMessageId: string;

  @Prop({ type: String, enum: FacebookMessageDirection, required: true })
  direction: FacebookMessageDirection;

  @Prop({ default: '' }) text: string;
  @Prop({ type: [String], default: [] }) attachments: string[];

  // Set on outbound messages sent from CDMS (captured name like the messaging
  // module's senderNameSnapshot — no populate needed).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  sentByStaff: Types.ObjectId;
  @Prop({ default: '' }) sentByName: string;

  @Prop() fbCreatedTime: Date;

  @Prop({ default: false }) isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookMessageSchema = SchemaFactory.createForClass(FacebookMessage);

FacebookMessageSchema.index({ conversation: 1, fbCreatedTime: 1 });
