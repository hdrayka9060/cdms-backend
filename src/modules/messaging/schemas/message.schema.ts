import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type MessageDocument = Message & Document;

/**
 * A single chat message in a conversation. Separate collection from
 * `conversations` (history is unbounded). `senderNameSnapshot` keeps old
 * messages attributable after a sender's User row is deleted. Edit/delete are
 * sender-only within a 6h window (enforced in the service). Delete is soft —
 * `body`/`attachments` are cleared and `isDeleted` flips so the client renders
 * a "message deleted" tombstone.
 */
@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Conversation', required: true })
  conversation: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  sender: Types.ObjectId;

  @Prop({ default: '' }) senderNameSnapshot: string;

  /**
   * System/event message (e.g. "Alice added Bob", "Carol left the group").
   * Rendered as centered notice text, not a chat bubble; never user-editable.
   * `sender` is the actor who triggered it; `body` is the rendered notice.
   */
  @Prop({ default: false }) isSystem: boolean;

  @Prop({ default: '' }) body: string;

  @Prop({
    type: [
      {
        url: { type: String, required: true },
        name: { type: String, default: '' },
        mimeType: { type: String, default: '' },
        size: { type: Number, default: 0 },
      },
    ],
    default: [],
  })
  attachments: { url: string; name: string; mimeType: string; size: number }[];

  @Prop({ default: false }) isEdited: boolean;
  @Prop({ type: Date, default: null }) editedAt: Date | null;
  @Prop({ default: false }) isDeleted: boolean;
  @Prop({ type: Date, default: null }) deletedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Page a conversation's history newest-first.
MessageSchema.index({ conversation: 1, createdAt: -1 });
