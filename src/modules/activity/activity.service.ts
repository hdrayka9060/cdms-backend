import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Activity, ActivityDocument } from './schemas/activity.schema';

/**
 * Input shape every caller uses to record an activity. Most fields optional
 * so a service can log with as much or as little detail as it has on hand.
 */
export interface ActivityLogInput {
  /** Feature area — drives icon/colour on the dashboard. Use the existing
   *  module string ("inventory", "leads", "accounting", "calendar", ...). */
  module: string;
  /** Short verb slug ("created", "updated", "deleted", "closed", "archived"). */
  action: string;
  /** Human-readable resource type ("Vehicle", "Lead", "Sale", ...). */
  entity: string;
  /** Resource id — string or ObjectId; either coerced to string. */
  entityId?: string | Types.ObjectId | null;
  /** Pre-formatted display label. Should make sense without any other context. */
  label: string;
  /** Actor display name (snapshot — survives a user rename). */
  byName?: string | null;
  /** Actor User._id. Anything non-ObjectId is dropped silently. */
  byId?: string | Types.ObjectId | null;
  /** Optional extra context the dashboard or future detail pages might use. */
  meta?: Record<string, any>;
}

/**
 * Append-only audit logger. Every "interesting" mutation in the system
 * calls `log()` — Dashboard reads through `listRecent()`.
 *
 * The service is registered globally (see ActivityModule) so any other
 * service can simply `@Inject()` it without dragging the activity module
 * into every feature module's import list.
 *
 * Failures are swallowed and logged. We never want activity-logging to
 * break a real user mutation.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectModel(Activity.name) private readonly model: Model<ActivityDocument>,
  ) {}

  async log(input: ActivityLogInput): Promise<void> {
    try {
      const byId =
        input.byId && isValidObjectId(input.byId) ? new Types.ObjectId(input.byId) : undefined;
      const entityId = input.entityId ? String(input.entityId) : undefined;

      // Resolve the actor's display name when the caller only supplied an
      // id. Service code can just pass `byId: userId` and skip the extra
      // controller wiring to format a name. Raw collection query avoids
      // a User-schema cross-module dependency in the activity module.
      let byName = input.byName;
      if (!byName && byId) {
        try {
          const u = await this.model.db
            .collection('users')
            .findOne(
              { _id: byId },
              { projection: { firstName: 1, lastName: 1, email: 1 } },
            );
          if (u) {
            const first = (u as any).firstName ?? '';
            const last = (u as any).lastName ?? '';
            const full = `${first} ${last}`.trim();
            byName = full || (u as any).email || undefined;
          }
        } catch {
          /* swallow — falls through to default 'System' below */
        }
      }

      await this.model.create({
        module: input.module,
        action: input.action,
        entity: input.entity,
        entityId,
        label: input.label.slice(0, 280), // hard cap so a wild detail can't blow the doc
        by: byName ?? 'System',
        byId,
        meta: input.meta ?? {},
      });
    } catch (err) {
      // Never fail the caller's primary write. Surface the cause so it's
      // debuggable, then move on.
      this.logger.error(
        `activity log failed module=${input.module} action=${input.action} entity=${input.entity}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Most-recent-first list. Used by GET /dashboard/activity.
   * `module` filter lets future per-entity detail pages reuse this same
   * service when we surface scoped activity (e.g. "Vehicle history").
   */
  async listRecent(opts?: {
    limit?: number;
    module?: string;
  }): Promise<ActivityDocument[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 200);
    const filter: any = { isDeleted: false };
    if (opts?.module) filter.module = opts.module;
    const docs = await this.model.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return docs as unknown as ActivityDocument[];
  }
}
