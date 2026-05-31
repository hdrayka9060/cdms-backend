import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarEvent, CalendarEventDocument } from './schemas/calendar-event.schema';

/**
 * Idempotent boot-time fixups for the `calendar_events` collection.
 *
 * Currently runs:
 *   1. `eventType: 'blocked'` → `'other'` rename. The enum value was renamed
 *      mid-project (the user explicitly asked: "Remove the current Blocked
 *      Event functionality and replace with Other"). Old rows still match
 *      the legacy value so this migration rewrites them on every boot.
 *      Re-running is a no-op (filter matches zero rows once migrated).
 *
 *   2. Cast string `assignedTo` and `vehicle` refs to ObjectId. The schema
 *      previously declared `@Prop({ type: Types.ObjectId, ref: 'X' })` which
 *      degrades to Mongoose `Mixed` (silent no-cast). Any row inserted
 *      while that bug was live has string refs. Same pattern as the Lead +
 *      Users migrators — see PROJECT_MEMORY.md §3.
 */
@Injectable()
export class CalendarMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(CalendarMigrator.name);

  constructor(
    @InjectModel(CalendarEvent.name)
    private readonly model: Model<CalendarEventDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.renameBlockedToOther();
    await this.castStringRefsToObjectId();
    await this.backfillCreatedBy();
  }

  /**
   * Events created before the `createdBy` field was added (earlier in this
   * session) have it missing entirely. The multi-user calendar filter
   * matches on createdBy OR assignedTo OR participants[].userId — so an
   * event with no creator never appears in ANY filtered view, only in
   * "All calendars".
   *
   * Best-effort backfill: when createdBy is missing AND assignedTo exists,
   * copy assignedTo into createdBy. The assignee is the most-likely creator
   * (the original UI tied the two together). Events with no assignee are
   * left untouched — there's no signal we can act on.
   *
   * Idempotent: subsequent runs filter on the same `createdBy missing`
   * condition, which is empty after the first successful pass.
   */
  private async backfillCreatedBy(): Promise<void> {
    try {
      const result = await this.model.collection.updateMany(
        {
          $and: [
            { $or: [{ createdBy: { $exists: false } }, { createdBy: null }] },
            { assignedTo: { $exists: true, $ne: null } },
          ],
        },
        [{ $set: { createdBy: '$assignedTo' } }],
      );
      if (result.modifiedCount > 0) {
        this.logger.log(
          `Backfilled createdBy on ${result.modifiedCount} legacy calendar event(s) using assignedTo`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Calendar createdBy backfill failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  private async renameBlockedToOther(): Promise<void> {
    try {
      const result = await this.model.collection.updateMany(
        { eventType: 'blocked' },
        { $set: { eventType: 'other' } },
      );
      if (result.modifiedCount > 0) {
        this.logger.log(`Migrated ${result.modifiedCount} calendar event(s): blocked → other`);
      }
    } catch (err) {
      // Never crash the app on migrator failure.
      this.logger.error(
        'Calendar blocked→other migration failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }

  private async castStringRefsToObjectId(): Promise<void> {
    try {
      const result = await this.model.collection.updateMany(
        {
          $or: [
            { assignedTo: { $type: 'string' } },
            { vehicle: { $type: 'string' } },
          ],
        },
        [
          {
            $set: {
              assignedTo: {
                $cond: [
                  { $eq: [{ $type: '$assignedTo' }, 'string'] },
                  { $toObjectId: '$assignedTo' },
                  '$assignedTo',
                ],
              },
              vehicle: {
                $cond: [
                  { $eq: [{ $type: '$vehicle' }, 'string'] },
                  { $toObjectId: '$vehicle' },
                  '$vehicle',
                ],
              },
            },
          },
        ],
      );
      if (result.modifiedCount > 0) {
        this.logger.log(
          `Migrated ${result.modifiedCount} calendar event(s): ref strings → ObjectId`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Calendar ref-cast migration failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
