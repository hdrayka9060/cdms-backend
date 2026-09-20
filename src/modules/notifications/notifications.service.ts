import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationCategory, NotificationDocument } from './schemas/notification.schema';
import { RecipientsService, RecipientSpec } from './recipients.service';
import { PushService } from './push.service';
import { MessagingGateway } from '../messaging/messaging.gateway';
import { MailService } from '../mail/mail.service';
import { User, UserDocument } from '../users/schemas/user.schema';

export interface NotifyPayload {
  type: string;
  category: NotificationCategory;
  title: string;
  body?: string;
  entity?: { kind: string; id: string };
  link?: string;
  actorId?: string;
  actorName?: string;
  meta?: Record<string, unknown>;
  /** When true, also email recipients whose prefs allow email for this category. */
  email?: boolean;
}

type ChannelPref = { inApp?: boolean; email?: boolean; push?: boolean };

const CATEGORIES = Object.values(NotificationCategory);
const DEFAULT_PREF: Required<ChannelPref> = { inApp: true, email: true, push: true };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  /** How long a READ notification is kept before Mongo's TTL purges it. */
  private static readonly RETENTION_DAYS = 90;

  constructor(
    @InjectModel(Notification.name) private readonly model: Model<NotificationDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly recipients: RecipientsService,
    private readonly gateway: MessagingGateway,
    private readonly mail: MailService,
    private readonly push: PushService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The single entry point. Resolves recipients (actor always excluded), writes
   * one row per in-app-opted recipient, pushes `notification:new` live over the
   * existing Socket.io gateway, and emails the high-value opted-in recipients.
   * Best-effort throughout — a failure here must never break the domain op that
   * triggered it (callers reach this via the async event bus anyway).
   */
  async notify(spec: RecipientSpec, payload: NotifyPayload): Promise<void> {
    try {
      const recipientIds = await this.recipients.resolve({
        ...spec,
        excludeUserIds: [...(spec.excludeUserIds ?? []), payload.actorId].filter(
          (x): x is string => !!x,
        ),
      });
      if (!recipientIds.length) return;

      const users = await this.userModel
        .find({ _id: { $in: recipientIds.map((id) => new Types.ObjectId(id)) } })
        .select('_id email notificationPrefs');

      const rows: Partial<Notification>[] = [];
      const emailTargets: string[] = [];
      const pushUserIds: string[] = [];
      for (const u of users) {
        const pref = this.prefFor(u.notificationPrefs, payload.category);
        if (pref.inApp !== false) {
          rows.push({
            user: u._id as Types.ObjectId,
            type: payload.type,
            category: payload.category,
            title: payload.title,
            body: payload.body ?? '',
            entity: payload.entity ?? null,
            link: payload.link ?? '',
            readAt: null,
            actorId: payload.actorId ? new Types.ObjectId(payload.actorId) : null,
            actorName: payload.actorName ?? '',
            meta: payload.meta ?? {},
          });
        }
        // Email is now a first-class channel: every notification also emails the
        // recipients whose per-category pref allows it (DEFAULT_PREF.email = true;
        // users mute per category in Account → Notifications). The mail-failed
        // ops alert is the sole exception — never email about a failed email
        // (avoids a loop). Actual send still depends on configured mail creds; in
        // dev mode MailService just logs the message.
        if (pref.email !== false && u.email && payload.type !== 'system.mail-failed') {
          emailTargets.push(u.email);
        }
        // Push is an independent per-category channel (DEFAULT_PREF.push = true;
        // muted per category in Account → Notifications). Gathered separately so
        // a user can, e.g., push Sales but not Appointments — regardless of their
        // in-app choice.
        if (pref.push !== false) pushUserIds.push(String(u._id));
      }

      if (rows.length) {
        await this.model.insertMany(rows);
        // Live in-app badge for open tabs (only the in-app recipients).
        this.gateway.emitToUsers(
          rows.map((r) => String(r.user)),
          'notification:new',
          { type: payload.type },
        );
      }

      // OS push to every recipient who allows push for this category — even when
      // the app is closed. Best-effort; no-op when push is unconfigured or a
      // recipient has no registered devices.
      if (pushUserIds.length) {
        void this.push.sendToUsers(pushUserIds, {
          title: payload.title,
          body: payload.body,
          url: payload.link ? this.absoluteLink(payload.link) : undefined,
          type: payload.type,
        });
      }

      if (emailTargets.length) {
        const link = payload.link ? this.absoluteLink(payload.link) : undefined;
        for (const to of emailTargets) {
          this.mail
            .sendNotification({ to, title: payload.title, body: payload.body, link })
            .catch((e) => this.logger.warn(`notification email failed to=${to}: ${e?.message ?? e}`));
        }
      }
    } catch (err: any) {
      this.logger.warn(`notify(${payload.type}) failed: ${err?.message ?? err}`);
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────
  async list(
    userId: string,
    opts: { unreadOnly?: boolean; limit?: number; cursor?: string },
  ): Promise<{ items: any[]; nextCursor: string | null; unreadCount: number }> {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
    const filter: Record<string, unknown> = { user: new Types.ObjectId(userId) };
    if (opts.unreadOnly) filter.readAt = null;
    if (opts.cursor) {
      const d = new Date(opts.cursor);
      if (!isNaN(d.getTime())) filter.createdAt = { $lt: d };
    }
    const docs = await this.model.find(filter).sort({ createdAt: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const unreadCount = await this.unreadCount(userId);
    return {
      items: page.map((d) => this.shape(d)),
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
      unreadCount,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.model.countDocuments({ user: new Types.ObjectId(userId), readAt: null });
  }

  async markRead(
    userId: string,
    opts: { ids?: string[]; all?: boolean },
  ): Promise<{ updated: number }> {
    const filter: Record<string, unknown> = { user: new Types.ObjectId(userId), readAt: null };
    if (!opts.all) {
      const ids = (opts.ids ?? []).filter((id) => Types.ObjectId.isValid(id));
      if (!ids.length) return { updated: 0 };
      filter._id = { $in: ids.map((id) => new Types.ObjectId(id)) };
    }
    // Stamp readAt now and schedule TTL cleanup RETENTION_DAYS later (read
    // notifications auto-purge; unread ones keep deleteAt=null and never expire).
    const now = new Date();
    const deleteAt = new Date(now.getTime() + NotificationsService.RETENTION_DAYS * 86_400_000);
    const res = await this.model.updateMany(filter, { $set: { readAt: now, deleteAt } });
    return { updated: res.modifiedCount ?? 0 };
  }

  // ── preferences (per-user) ────────────────────────────────────────────────
  async getPrefs(userId: string): Promise<Record<string, Required<ChannelPref>>> {
    const u = await this.userModel.findById(userId).select('notificationPrefs');
    return this.normalizePrefs(u?.notificationPrefs);
  }

  async setPrefs(
    userId: string,
    prefs: Record<string, ChannelPref>,
  ): Promise<Record<string, Required<ChannelPref>>> {
    const normalized = this.normalizePrefs(prefs);
    await this.userModel.updateOne({ _id: userId }, { $set: { notificationPrefs: normalized } });
    return normalized;
  }

  // ── internals ───────────────────────────────────────────────────────────
  private prefFor(
    prefs: Record<string, ChannelPref> | undefined | null,
    category: string,
  ): Required<ChannelPref> {
    const p = (prefs as Record<string, ChannelPref>)?.[category];
    return {
      inApp: p?.inApp ?? DEFAULT_PREF.inApp,
      email: p?.email ?? DEFAULT_PREF.email,
      push: p?.push ?? DEFAULT_PREF.push,
    };
  }

  private normalizePrefs(
    prefs: Record<string, ChannelPref> | undefined | null,
  ): Record<string, Required<ChannelPref>> {
    const out: Record<string, Required<ChannelPref>> = {};
    for (const cat of CATEGORIES) out[cat] = this.prefFor(prefs, cat);
    return out;
  }

  private absoluteLink(link: string): string {
    const base = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
    if (!base) return link;
    return link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
  }

  private shape(d: NotificationDocument) {
    return {
      id: String(d._id),
      type: d.type,
      category: d.category,
      title: d.title,
      body: d.body,
      entity: d.entity,
      link: d.link,
      read: !!d.readAt,
      readAt: d.readAt ? d.readAt.toISOString() : null,
      actorName: d.actorName,
      meta: d.meta,
      createdAt: d.createdAt.toISOString(),
    };
  }
}
