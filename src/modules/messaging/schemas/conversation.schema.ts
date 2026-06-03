import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document;

export enum ConversationType {
  DIRECT = 'direct',
  GROUP = 'group',
}

export enum ParticipantRole {
  MEMBER = 'member',
  ADMIN = 'admin',
}

/**
 * A chat thread — either a 1:1 DM (`direct`) or a `group`.
 *
 * Membership lives embedded in `participants[]` along with a per-user read
 * cursor (`lastReadAt`) that powers unread counts, and `nameSnapshot` so a
 * participant still renders after their User row is deleted. `leftAt` marks a
 * participant who left / was removed / was deleted-as-staff (the "User left"
 * state) — the entry is kept, never pulled, so history stays attributable.
 *
 * Messages are a SEPARATE collection (`messages`) — chat history is unbounded
 * and would blow the 16 MB document limit if embedded.
 */
@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation {
  @Prop({ type: String, enum: ConversationType, required: true }) type: ConversationType;

  /** Group metadata — empty for direct conversations. */
  @Prop({ default: '' }) name: string;
  @Prop({ default: '' }) description: string;

  /**
   * Group setting (admin-controlled): when a NEW member is added, should they
   * see messages from before they joined? Captured PER-PARTICIPANT at join time
   * (`participant.historyVisibleFrom`), so toggling this later never changes
   * access for members who already joined.
   */
  @Prop({ default: true }) shareHistoryWithNewMembers: boolean;

  /**
   * For `direct` conversations: the two participant ids sorted and joined with
   * ':' — a deterministic key with a unique index so a DM pair can never spawn
   * duplicate threads. Intentionally NOT set (field absent) on groups: a sparse
   * index still indexes an explicit `null`, so a stored-null default would make
   * the 2nd group collide. The partial index below only covers string keys.
   */
  @Prop({ type: String }) directKey?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  // Subdoc array: `{ type: X }` per subfield (the project's locked Mongoose
  // syntax rule), ObjectId refs via MongooseSchema.Types.ObjectId (NOT
  // Types.ObjectId — that silently degrades to Mixed).
  @Prop({
    type: [
      {
        user: { type: MongooseSchema.Types.ObjectId, ref: 'User', required: true },
        nameSnapshot: { type: String, default: '' },
        role: { type: String, enum: ['member', 'admin'], default: 'member' },
        joinedAt: { type: Date, default: Date.now },
        leftAt: { type: Date, default: null },
        lastReadAt: { type: Date, default: null },
        // null = can see the FULL history. A date = can only see messages from
        // that instant onward (set at join time when sharing was OFF). Frozen
        // at join — later toggles of shareHistoryWithNewMembers don't change it.
        historyVisibleFrom: { type: Date, default: null },
      },
    ],
    default: [],
  })
  participants: {
    user: Types.ObjectId;
    nameSnapshot: string;
    role: ParticipantRole;
    joinedAt: Date;
    leftAt: Date | null;
    lastReadAt: Date | null;
    historyVisibleFrom: Date | null;
  }[];

  /** Denormalized for cheap conversation-list ordering + preview. */
  @Prop({ type: Date, default: null }) lastMessageAt: Date | null;
  @Prop({ default: '' }) lastMessagePreview: string;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

// List "my conversations, newest activity first".
ConversationSchema.index({ 'participants.user': 1, lastMessageAt: -1 });
// One DM thread per pair. Partial (string keys only) so groups — which have no
// directKey — are never indexed and can't collide. Named so it can replace the
// older `directKey_1` sparse index after a one-time drop.
ConversationSchema.index(
  { directKey: 1 },
  { unique: true, partialFilterExpression: { directKey: { $type: 'string' } }, name: 'directKey_unique' },
);
