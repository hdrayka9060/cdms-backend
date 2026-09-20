import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as webpush from 'web-push';
import { PushSubscription, PushSubscriptionDocument } from './schemas/push-subscription.schema';

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  type?: string;
}

interface RawSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Web Push transport. Stores per-device subscriptions and delivers OS-level
 * notifications that reach a phone/desktop even when the app is closed. Mirrors
 * the dev-mode-fallback pattern used by MailService: with no VAPID keys it's
 * simply disabled (in-app + email still work). Best-effort — a push failure
 * never breaks a domain op, and dead subscriptions (404/410) are pruned.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private enabled = false;
  private publicKey = '';

  constructor(
    @InjectModel(PushSubscription.name) private readonly model: Model<PushSubscriptionDocument>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const pub = this.config.get<string>('VAPID_PUBLIC_KEY');
    const priv = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT') || 'mailto:admin@example.com';
    if (pub && priv) {
      webpush.setVapidDetails(subject, pub, priv);
      this.publicKey = pub;
      this.enabled = true;
      this.logger.log('🔔 Web Push enabled (VAPID configured)');
    } else {
      this.logger.warn(
        'Web Push disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable OS push notifications.',
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
  getPublicKey(): string {
    return this.publicKey;
  }

  /** Store (or refresh) a device's subscription, keyed by its unique endpoint. */
  async saveSubscription(userId: string, sub: RawSubscription, userAgent = ''): Promise<void> {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new BadRequestException('Invalid push subscription');
    }
    await this.model.updateOne(
      { endpoint: sub.endpoint },
      {
        $set: {
          user: new Types.ObjectId(userId),
          endpoint: sub.endpoint,
          keys: sub.keys,
          userAgent: userAgent.slice(0, 300),
        },
      },
      { upsert: true },
    );
  }

  async removeSubscription(userId: string, endpoint: string): Promise<void> {
    if (!endpoint) return;
    await this.model.deleteOne({ endpoint, user: new Types.ObjectId(userId) });
  }

  /**
   * Push to every registered device of the given users. Best-effort and
   * parallel; a gone subscription (404/410) is deleted so we stop trying it.
   */
  async sendToUsers(userIds: string[], payload: PushPayload): Promise<void> {
    if (!this.enabled || !userIds.length) return;
    const subs = await this.model.find({
      user: { $in: userIds.map((id) => new Types.ObjectId(id)) },
    });
    if (!subs.length) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: s.keys } as webpush.PushSubscription,
            body,
          );
        } catch (err: unknown) {
          const code = (err as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            await this.model.deleteOne({ _id: s._id }).catch(() => undefined);
          } else {
            this.logger.warn(
              `push send failed (${code ?? '?'}) endpoint=${s.endpoint.slice(0, 40)}…: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }),
    );
  }
}
