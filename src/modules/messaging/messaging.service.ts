import {
  Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Conversation, ConversationDocument, ConversationType, ParticipantRole,
} from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { ActivityService } from '../activity/activity.service';
import { MessagingGateway } from './messaging.gateway';
import {
  CreateConversationDto, UpdateGroupDto, AddParticipantsDto, SendMessageDto,
  EditMessageDto, ListMessagesDto,
} from './dto/messaging.dto';

/** Window during which a sender may edit/delete their own message. */
const EDIT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface Actor {
  id: string;
  name: string;
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    // Re-registered schema (no module cycle) — used to capture name snapshots
    // and resolve each participant's live name / deleted status for display.
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly activity: ActivityService,
    // One-way dependency (service → gateway); the gateway never imports the
    // service, so there's no provider cycle.
    private readonly gateway: MessagingGateway,
  ) {}

  /** User ids of a conversation's currently-active participants. */
  private activeIds(conv: ConversationDocument): string[] {
    return conv.participants.filter((p) => !p.leftAt).map((p) => String(p.user));
  }

  // ── Authorization helpers (own-chats-only) ────────────────────────────────

  /** Load a conversation the caller is an ACTIVE member of, or throw. */
  private async loadAsMember(conversationId: string, meId: string): Promise<ConversationDocument> {
    if (!Types.ObjectId.isValid(conversationId)) throw new NotFoundException('Conversation not found');
    const conv = await this.conversationModel.findOne({ _id: conversationId, isDeleted: false });
    if (!conv) throw new NotFoundException('Conversation not found');
    const me = conv.participants.find((p) => String(p.user) === meId && !p.leftAt);
    if (!me) throw new ForbiddenException('You are not a participant in this conversation');
    return conv;
  }

  private assertGroupAdmin(conv: ConversationDocument, meId: string): void {
    if (conv.type !== ConversationType.GROUP) {
      throw new BadRequestException('Only group conversations can be managed');
    }
    const me = conv.participants.find((p) => String(p.user) === meId && !p.leftAt);
    const isAdmin = me?.role === ParticipantRole.ADMIN || String(conv.createdBy) === meId;
    if (!isAdmin) throw new ForbiddenException('Only a group admin can do that');
  }

  // ── Name / status resolution ──────────────────────────────────────────────

  private async loadUsers(ids: string[]): Promise<Map<string, { name: string; isDeleted: boolean }>> {
    const unique = [...new Set(ids.map(String))].filter((id) => Types.ObjectId.isValid(id));
    const docs = await this.userModel
      .find({ _id: { $in: unique.map((id) => new Types.ObjectId(id)) } })
      .select('firstName lastName isDeleted')
      .lean();
    const map = new Map<string, { name: string; isDeleted: boolean }>();
    for (const d of docs as any[]) {
      map.set(String(d._id), {
        name: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || 'Unknown',
        isDeleted: !!d.isDeleted,
      });
    }
    return map;
  }

  /** Shape a conversation for the client: resolved participants + my unread count. */
  private async enrich(conv: ConversationDocument, meId: string): Promise<any> {
    const users = await this.loadUsers(conv.participants.map((p) => String(p.user)));
    const me = conv.participants.find((p) => String(p.user) === meId);
    const participants = conv.participants.map((p) => {
      const live = users.get(String(p.user));
      const accountDeleted = live?.isDeleted ?? true;
      const hasLeft = !!p.leftAt;
      return {
        userId: String(p.user),
        // Prefer the live name; fall back to the captured snapshot if the
        // account is gone. `hasLeft` drives the "User left" UI.
        name: live && !accountDeleted ? live.name : p.nameSnapshot || live?.name || 'User',
        role: p.role,
        hasLeft: hasLeft || accountDeleted,
        isYou: String(p.user) === meId,
      };
    });
    const unreadCount = await this.unreadCountFor(conv._id, meId, me?.lastReadAt ?? null, me?.historyVisibleFrom ?? null);
    return {
      _id: String(conv._id),
      type: conv.type,
      name: conv.name,
      description: conv.description,
      shareHistoryWithNewMembers: conv.shareHistoryWithNewMembers,
      createdBy: conv.createdBy ? String(conv.createdBy) : null,
      participants,
      lastMessageAt: conv.lastMessageAt,
      lastMessagePreview: conv.lastMessagePreview,
      unreadCount,
      myRole: me?.role ?? null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  private async unreadCountFor(
    conversationId: any, meId: string, lastReadAt: Date | null, historyFloor: Date | null = null,
  ): Promise<number> {
    const filter: any = {
      conversation: conversationId,
      isDeleted: false,
      sender: { $ne: new Types.ObjectId(meId) },
    };
    const createdAt: any = {};
    if (lastReadAt) createdAt.$gt = lastReadAt;
    // A member who joined while history-sharing was OFF never counts (or sees)
    // messages from before they joined.
    if (historyFloor) createdAt.$gte = historyFloor;
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;
    return this.messageModel.countDocuments(filter);
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  async createConversation(dto: CreateConversationDto, actor: Actor): Promise<any> {
    const meId = actor.id;
    const otherIds = [...new Set(dto.participantIds.map(String))].filter((id) => id !== meId);

    if (dto.type === ConversationType.DIRECT) {
      if (otherIds.length > 1) {
        throw new BadRequestException('A direct conversation needs exactly one other participant');
      }

      // Self-DM ("Notes to self") — the user listed only themselves. One per user
      // via a deterministic `me:me` directKey.
      if (otherIds.length === 0) {
        const selfKey = `${meId}:${meId}`;
        const existingSelf = await this.conversationModel.findOne({ directKey: selfKey, isDeleted: false });
        if (existingSelf) return this.enrich(existingSelf, meId);
        const createdSelf = await this.conversationModel.create({
          type: ConversationType.DIRECT,
          directKey: selfKey,
          createdBy: new Types.ObjectId(meId),
          participants: [
            { user: new Types.ObjectId(meId), nameSnapshot: actor.name, role: ParticipantRole.MEMBER },
          ],
        });
        this.gateway.emitToUsers([meId], 'conversation:updated', { conversationId: String(createdSelf._id) });
        return this.enrich(createdSelf, meId);
      }

      const otherId = otherIds[0];
      const users = await this.loadUsers([otherId]);
      const other = users.get(otherId);
      if (!other || other.isDeleted) throw new BadRequestException('That user is not available');

      const directKey = [meId, otherId].sort().join(':');
      const existing = await this.conversationModel.findOne({ directKey, isDeleted: false });
      if (existing) return this.enrich(existing, meId); // idempotent — never duplicate a DM

      const created = await this.conversationModel.create({
        type: ConversationType.DIRECT,
        directKey,
        createdBy: new Types.ObjectId(meId),
        participants: [
          { user: new Types.ObjectId(meId), nameSnapshot: actor.name, role: ParticipantRole.MEMBER },
          { user: new Types.ObjectId(otherId), nameSnapshot: other.name, role: ParticipantRole.MEMBER },
        ],
      });
      this.gateway.emitToUsers(this.activeIds(created), 'conversation:updated', { conversationId: String(created._id) });
      return this.enrich(created, meId);
    }

    // GROUP
    if (!dto.name?.trim()) throw new BadRequestException('A group needs a name');
    const users = await this.loadUsers(otherIds);
    const members = otherIds.filter((id) => users.get(id) && !users.get(id)!.isDeleted);

    const created = await this.conversationModel.create({
      type: ConversationType.GROUP,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? '',
      shareHistoryWithNewMembers: dto.shareHistoryWithNewMembers ?? true,
      createdBy: new Types.ObjectId(meId),
      participants: [
        { user: new Types.ObjectId(meId), nameSnapshot: actor.name, role: ParticipantRole.ADMIN },
        ...members.map((id) => ({
          user: new Types.ObjectId(id),
          nameSnapshot: users.get(id)!.name,
          role: ParticipantRole.MEMBER,
        })),
      ],
    });

    await this.safeLog({
      action: 'group-created', entityId: created._id, label: created.name, actor,
      meta: { members: members.length + 1 },
    });
    this.gateway.emitToUsers(this.activeIds(created), 'conversation:updated', { conversationId: String(created._id) });
    await this.postSystemMessage(created, meId, actor.name, `${actor.name} created the group`);
    return this.enrich(created, meId);
  }

  async listConversations(meId: string): Promise<any[]> {
    const convs = await this.conversationModel
      .find({ isDeleted: false, participants: { $elemMatch: { user: new Types.ObjectId(meId), leftAt: null } } })
      .sort({ lastMessageAt: -1, updatedAt: -1 });
    return Promise.all(convs.map((c) => this.enrich(c, meId)));
  }

  async getConversation(id: string, meId: string): Promise<any> {
    const conv = await this.loadAsMember(id, meId);
    return this.enrich(conv, meId);
  }

  /**
   * Active staff for the chat people-picker. Gated by Communication (NOT Staff)
   * so any chat user can start DMs / add members even without `Staff:view`.
   */
  async directory(): Promise<Array<{ id: string; name: string; email: string; roleName?: string }>> {
    const users = await this.userModel
      .find({ isDeleted: false, status: 'active' })
      .select('firstName lastName email roleId')
      .populate('roleId', 'name')
      .sort({ firstName: 1 })
      .lean();
    return (users as any[]).map((u) => ({
      id: String(u._id),
      name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email,
      email: u.email,
      roleName: u.roleId?.name,
    }));
  }

  async updateGroup(id: string, dto: UpdateGroupDto, actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(id, actor.id);
    this.assertGroupAdmin(conv, actor.id);
    const prevName = conv.name;
    const prevDescription = conv.description;
    const prevShare = conv.shareHistoryWithNewMembers;
    if (dto.name !== undefined) conv.name = dto.name.trim();
    if (dto.description !== undefined) conv.description = dto.description.trim();
    if (dto.shareHistoryWithNewMembers !== undefined) conv.shareHistoryWithNewMembers = dto.shareHistoryWithNewMembers;
    await conv.save();
    await this.safeLog({ action: 'group-updated', entityId: conv._id, label: conv.name, actor });
    this.gateway.emitToUsers(this.activeIds(conv), 'conversation:updated', { conversationId: String(conv._id) });
    if (conv.name !== prevName) {
      await this.postSystemMessage(conv, actor.id, actor.name, `${actor.name} renamed the group to "${conv.name}"`);
    } else if (conv.description !== prevDescription) {
      await this.postSystemMessage(conv, actor.id, actor.name, `${actor.name} updated the group description`);
    }
    if (conv.shareHistoryWithNewMembers !== prevShare) {
      await this.postSystemMessage(
        conv, actor.id, actor.name,
        `${actor.name} turned ${conv.shareHistoryWithNewMembers ? 'on' : 'off'} chat history for newly-added members`,
      );
    }
    return this.enrich(conv, actor.id);
  }

  async deleteGroup(id: string, actor: Actor): Promise<{ deleted: true }> {
    const conv = await this.loadAsMember(id, actor.id);
    this.assertGroupAdmin(conv, actor.id);
    conv.isDeleted = true;
    conv.deletedAt = new Date();
    await conv.save();
    await this.safeLog({ action: 'group-deleted', entityId: conv._id, label: conv.name, actor });
    this.gateway.emitToUsers(this.activeIds(conv), 'conversation:updated', { conversationId: String(conv._id) });
    return { deleted: true };
  }

  async addParticipants(id: string, dto: AddParticipantsDto, actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(id, actor.id);
    if (conv.type !== ConversationType.GROUP) {
      throw new BadRequestException('Members can only be added to group conversations');
    }
    // Any active member can add others (not just admins) — by design.
    const users = await this.loadUsers(dto.userIds);
    // History visibility for the joiners is frozen NOW from the current group
    // setting; later toggles never change it.
    const floor = conv.shareHistoryWithNewMembers ? null : new Date();
    const addedNames: string[] = [];
    for (const userId of [...new Set(dto.userIds.map(String))]) {
      const live = users.get(userId);
      if (!live || live.isDeleted) continue; // skip unknown / removed users
      const existing = conv.participants.find((p) => String(p.user) === userId);
      if (existing && !existing.leftAt) continue; // already active
      if (existing) {
        existing.leftAt = null; // rejoin
        existing.joinedAt = new Date();
        existing.nameSnapshot = live.name;
        existing.lastReadAt = null;
        existing.historyVisibleFrom = floor;
      } else {
        conv.participants.push({
          user: new Types.ObjectId(userId),
          nameSnapshot: live.name,
          role: ParticipantRole.MEMBER,
          joinedAt: new Date(),
          leftAt: null,
          lastReadAt: null,
          historyVisibleFrom: floor,
        } as any);
      }
      addedNames.push(live.name);
    }
    await conv.save();
    await this.safeLog({ action: 'group-members-added', entityId: conv._id, label: conv.name, actor });
    this.gateway.emitToUsers(this.activeIds(conv), 'conversation:updated', { conversationId: String(conv._id) });
    if (addedNames.length) {
      await this.postSystemMessage(conv, actor.id, actor.name, `${actor.name} added ${addedNames.join(', ')}`);
    }
    return this.enrich(conv, actor.id);
  }

  /** Remove a member (admin) — or leave the group yourself (target === self). */
  async removeParticipant(id: string, targetUserId: string, actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(id, actor.id);
    const isSelfLeave = targetUserId === actor.id;
    if (!isSelfLeave) this.assertGroupAdmin(conv, actor.id);
    else if (conv.type !== ConversationType.GROUP) {
      throw new BadRequestException('Only group conversations can be left');
    }
    const target = conv.participants.find((p) => String(p.user) === targetUserId && !p.leftAt);
    if (!target) throw new NotFoundException('That member is not in the group');
    const targetName = target.nameSnapshot || 'A member';
    const activeMembers = conv.participants.filter((p) => !p.leftAt);

    if (isSelfLeave) {
      // Last person leaving → delete the group (no admin handoff needed).
      if (activeMembers.length <= 1) {
        target.leftAt = new Date();
        conv.isDeleted = true;
        conv.deletedAt = new Date();
        await conv.save();
        await this.safeLog({ action: 'group-deleted', entityId: conv._id, label: conv.name, actor });
        this.gateway.emitToUsers([actor.id], 'conversation:updated', { conversationId: String(conv._id) });
        return { _id: String(conv._id), deleted: true };
      }
      // Sole admin leaving while others remain → must hand off admin first.
      const iAmAdmin = target.role === ParticipantRole.ADMIN;
      const anotherAdminRemains = activeMembers.some(
        (p) => String(p.user) !== actor.id && p.role === ParticipantRole.ADMIN,
      );
      if (iAmAdmin && !anotherAdminRemains) {
        throw new BadRequestException('You are the only admin. Make another member an admin before leaving.');
      }
    }

    target.leftAt = new Date();
    await conv.save();
    await this.safeLog({
      action: isSelfLeave ? 'group-left' : 'group-member-removed',
      entityId: conv._id, label: conv.name, actor, meta: { targetUserId },
    });
    // Notify remaining members + the removed person (so their UI drops it).
    this.gateway.emitToUsers([...this.activeIds(conv), targetUserId], 'conversation:updated', { conversationId: String(conv._id) });
    await this.postSystemMessage(
      conv, actor.id, actor.name,
      isSelfLeave ? `${actor.name} left the group` : `${actor.name} removed ${targetName}`,
    );
    return this.enrich(conv, actor.id);
  }

  /** Promote/demote a member (admin only). Can't change your own role. */
  async setParticipantRole(id: string, targetUserId: string, role: 'admin' | 'member', actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(id, actor.id);
    this.assertGroupAdmin(conv, actor.id);
    if (targetUserId === actor.id) throw new BadRequestException('You cannot change your own role');
    const target = conv.participants.find((p) => String(p.user) === targetUserId && !p.leftAt);
    if (!target) throw new NotFoundException('That member is not in the group');
    const newRole = role === 'admin' ? ParticipantRole.ADMIN : ParticipantRole.MEMBER;
    if (target.role === newRole) return this.enrich(conv, actor.id);
    target.role = newRole;
    await conv.save();
    await this.safeLog({
      action: 'group-role-changed', entityId: conv._id, label: conv.name, actor,
      meta: { targetUserId, role: newRole },
    });
    this.gateway.emitToUsers(this.activeIds(conv), 'conversation:updated', { conversationId: String(conv._id) });
    await this.postSystemMessage(
      conv, actor.id, actor.name,
      newRole === ParticipantRole.ADMIN
        ? `${actor.name} made ${target.nameSnapshot} an admin`
        : `${actor.name} removed admin from ${target.nameSnapshot}`,
    );
    return this.enrich(conv, actor.id);
  }

  async markRead(id: string, meId: string): Promise<{ ok: true }> {
    const conv = await this.loadAsMember(id, meId);
    const me = conv.participants.find((p) => String(p.user) === meId && !p.leftAt);
    if (me) {
      me.lastReadAt = new Date();
      await conv.save();
    }
    return { ok: true };
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  async listMessages(id: string, meId: string, query: ListMessagesDto): Promise<any[]> {
    const conv = await this.loadAsMember(id, meId);
    const me = conv.participants.find((p) => String(p.user) === meId && !p.leftAt);
    const filter: any = { conversation: new Types.ObjectId(id) };
    const createdAt: any = {};
    if (query.before) {
      const cursor = new Date(query.before);
      if (!isNaN(cursor.getTime())) createdAt.$lt = cursor;
    }
    // A member who joined while history-sharing was OFF only sees messages from
    // their join onward (frozen at join — see addParticipants).
    if (me?.historyVisibleFrom) createdAt.$gte = me.historyVisibleFrom;
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;
    const limit = Math.min(query.limit ?? 50, 100);
    const docs = await this.messageModel.find(filter).sort({ createdAt: -1 }).limit(limit);
    // Return chronological (oldest → newest) for the chat view.
    return docs.reverse().map((m) => this.shapeMessage(m, meId));
  }

  async sendMessage(
    id: string, dto: SendMessageDto, files: Express.Multer.File[], actor: Actor,
  ): Promise<any> {
    const conv = await this.loadAsMember(id, actor.id);
    const body = (dto.body ?? '').trim();
    const attachments = (files ?? []).map((f) => ({
      url: `/uploads/messages/${f.filename}`,
      name: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
    }));
    if (!body && attachments.length === 0) {
      throw new BadRequestException('A message needs text or at least one attachment');
    }

    const msg = await this.messageModel.create({
      conversation: new Types.ObjectId(id),
      sender: new Types.ObjectId(actor.id),
      senderNameSnapshot: actor.name,
      body,
      attachments,
    });

    const preview = body
      ? body.slice(0, 120)
      : `📎 ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`;
    await this.conversationModel.updateOne(
      { _id: id },
      { $set: { lastMessageAt: msg.createdAt, lastMessagePreview: preview } },
    );

    const shaped = this.shapeMessage(msg, actor.id);
    // Push to active participants; recipients' clients recompute `isMine` from senderId.
    this.gateway.emitToUsers(this.activeIds(conv), 'message:new', { conversationId: id, message: shaped });
    return shaped;
  }

  async editMessage(convId: string, messageId: string, dto: EditMessageDto, actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(convId, actor.id);
    const msg = await this.loadOwnEditableMessage(convId, messageId, actor.id);
    msg.body = dto.body.trim();
    msg.isEdited = true;
    msg.editedAt = new Date();
    await msg.save();
    const shaped = this.shapeMessage(msg, actor.id);
    this.gateway.emitToUsers(this.activeIds(conv), 'message:edited', { conversationId: convId, message: shaped });
    return shaped;
  }

  async deleteMessage(convId: string, messageId: string, actor: Actor): Promise<any> {
    const conv = await this.loadAsMember(convId, actor.id);
    const msg = await this.loadOwnEditableMessage(convId, messageId, actor.id);
    msg.isDeleted = true;
    msg.deletedAt = new Date();
    msg.body = '';
    msg.attachments = [] as any;
    await msg.save();
    const shaped = this.shapeMessage(msg, actor.id);
    this.gateway.emitToUsers(this.activeIds(conv), 'message:deleted', { conversationId: convId, message: shaped });
    return shaped;
  }

  /** Load a message the caller may still edit/delete (own + within 6h + not already deleted). */
  private async loadOwnEditableMessage(convId: string, messageId: string, meId: string): Promise<MessageDocument> {
    if (!Types.ObjectId.isValid(messageId)) throw new NotFoundException('Message not found');
    const msg = await this.messageModel.findOne({ _id: messageId, conversation: new Types.ObjectId(convId) });
    if (!msg || msg.isDeleted) throw new NotFoundException('Message not found');
    if (msg.isSystem) throw new ForbiddenException('System messages cannot be edited or deleted');
    if (String(msg.sender) !== meId) throw new ForbiddenException('You can only edit your own messages');
    if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException('The 6-hour edit window for this message has expired');
    }
    return msg;
  }

  private shapeMessage(m: MessageDocument, meId: string): any {
    return {
      _id: String(m._id),
      conversation: String(m.conversation),
      senderId: String(m.sender),
      senderName: m.senderNameSnapshot,
      isMine: !m.isSystem && String(m.sender) === meId,
      isSystem: m.isSystem,
      body: m.isDeleted ? '' : m.body,
      attachments: m.isDeleted ? [] : m.attachments,
      isEdited: m.isEdited,
      editedAt: m.editedAt,
      isDeleted: m.isDeleted,
      createdAt: m.createdAt,
      // Lets the client show/hide the edit-delete affordance without its own clock.
      editableUntil: new Date(new Date(m.createdAt).getTime() + EDIT_WINDOW_MS),
    };
  }

  /**
   * Append a system/event notice (e.g. "Alice added Bob") to a conversation and
   * push it live, exactly like a normal message but flagged `isSystem` so the
   * client renders it as a centered notice and never lets anyone edit/delete it.
   */
  private async postSystemMessage(
    conv: ConversationDocument, actorId: string, actorName: string, text: string,
  ): Promise<void> {
    const msg = await this.messageModel.create({
      conversation: conv._id,
      sender: new Types.ObjectId(actorId),
      senderNameSnapshot: actorName,
      isSystem: true,
      body: text,
    });
    await this.conversationModel.updateOne(
      { _id: conv._id },
      { $set: { lastMessageAt: msg.createdAt, lastMessagePreview: text.slice(0, 120) } },
    );
    this.gateway.emitToUsers(this.activeIds(conv), 'message:new', {
      conversationId: String(conv._id),
      message: this.shapeMessage(msg, actorId),
    });
  }

  async unreadTotal(meId: string): Promise<number> {
    const convs = await this.listConversations(meId);
    return convs.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  }

  // ── Staff-removal cascade (called by UsersService.softDelete) ──────────────

  /**
   * When a staff member is removed, drop them from every conversation
   * (direct + group) by stamping `leftAt`. The participant row is KEPT so
   * surviving members still see the thread with that slot rendered as
   * "User left" and the history stays attributable. Best-effort.
   */
  async onUserRemoved(userId: string): Promise<{ conversations: number }> {
    if (!Types.ObjectId.isValid(userId)) return { conversations: 0 };
    const uid = new Types.ObjectId(userId);
    const res = await this.conversationModel.updateMany(
      { 'participants.user': uid, 'participants.leftAt': null },
      { $set: { 'participants.$[p].leftAt': new Date() } },
      { arrayFilters: [{ 'p.user': uid }] },
    );
    const count = (res as any).modifiedCount ?? 0;
    if (count) this.logger.log(`onUserRemoved: removed user ${userId} from ${count} conversation(s)`);
    // Tell surviving members to re-render (their slot → "User left") and drop
    // the removed user's live sockets. Best-effort.
    try {
      const affected = await this.conversationModel.find({ isDeleted: false, 'participants.user': uid });
      for (const c of affected) {
        const others = this.activeIds(c).filter((pid) => pid !== userId);
        if (!others.length) continue;
        this.gateway.emitToUsers(others, 'conversation:updated', { conversationId: String(c._id) });
        if (c.type === ConversationType.GROUP) {
          const removed = c.participants.find((p) => String(p.user) === userId);
          const name = removed?.nameSnapshot || 'A teammate';
          await this.postSystemMessage(c, userId, name, `${name} left the group`);
        }
      }
      this.gateway.disconnectUser(userId);
    } catch (err: any) {
      this.logger.warn(`onUserRemoved emit failed: ${err?.message}`);
    }
    return { conversations: count };
  }

  // ── internal ────────────────────────────────────────────────────────────────

  private async safeLog(opts: {
    action: string; entityId: any; label: string; actor: Actor; meta?: any;
  }): Promise<void> {
    try {
      await this.activity.log({
        module: 'communication',
        action: opts.action,
        entity: 'Conversation',
        entityId: opts.entityId,
        label: opts.label,
        byId: opts.actor.id,
        meta: opts.meta,
      });
    } catch (err: any) {
      this.logger.warn(`activity log failed (${opts.action}): ${err?.message}`);
    }
  }
}
