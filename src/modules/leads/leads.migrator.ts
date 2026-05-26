import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Lead, LeadDocument, LeadStatus } from './schemas/lead.schema';

/**
 * One-shot data fixups run on application bootstrap. All migrations here MUST
 * be idempotent — they run on every boot, and re-applying them should be a
 * no-op once the data is clean.
 *
 * Failures are logged but never crash the app.
 *
 * Migrations currently applied (in order):
 *   1. status: 'dropped' → 'archived' (rename to match the new enum).
 *   2. vehicle / buyer fields stored as strings → ObjectId. The schema
 *      originally used `type: Types.ObjectId` which Mongoose treats as Mixed
 *      (silent no-cast), so any lead created via the API up to this point
 *      has these refs as plain strings. That broke filter matches in the
 *      sibling-archive and inverse-transition cascades. Schema is now fixed
 *      to `Schema.Types.ObjectId`, but existing rows need a one-time rewrite.
 */
@Injectable()
export class LeadsMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeadsMigrator.name);

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.renameDroppedToArchived();
    await this.castStringRefsToObjectId();
  }

  private async renameDroppedToArchived(): Promise<void> {
    try {
      const result = await this.leadModel.updateMany(
        { status: 'dropped' as any },
        { $set: { status: LeadStatus.ARCHIVED } },
      );
      if (result.modifiedCount > 0) {
        this.logger.log(`Migrated ${result.modifiedCount} lead(s) from 'dropped' → 'archived'`);
      }
    } catch (err) {
      this.logger.error('Lead status migration failed', err instanceof Error ? err.stack : err);
    }
  }

  /**
   * Convert string ObjectId-shaped values in vehicle/buyer/assignedTo to real
   * BSON ObjectIds. Uses an aggregation-pipeline update so each field is
   * coerced via `$toObjectId` server-side — no roundtrip to Node land.
   *
   * Skips rows where the field is already an ObjectId or doesn't exist.
   */
  private async castStringRefsToObjectId(): Promise<void> {
    const collection = this.leadModel.collection;
    try {
      const result = await collection.updateMany(
        {
          $or: [
            { vehicle: { $type: 'string' } },
            { buyer: { $type: 'string' } },
            { assignedTo: { $type: 'string' } },
          ],
        },
        [
          {
            $set: {
              vehicle: {
                $cond: [
                  { $eq: [{ $type: '$vehicle' }, 'string'] },
                  { $toObjectId: '$vehicle' },
                  '$vehicle',
                ],
              },
              buyer: {
                $cond: [
                  { $eq: [{ $type: '$buyer' }, 'string'] },
                  { $toObjectId: '$buyer' },
                  '$buyer',
                ],
              },
              assignedTo: {
                $cond: [
                  { $eq: [{ $type: '$assignedTo' }, 'string'] },
                  { $toObjectId: '$assignedTo' },
                  '$assignedTo',
                ],
              },
            },
          },
        ],
      );
      if (result.modifiedCount > 0) {
        this.logger.log(
          `Migrated ${result.modifiedCount} lead(s): string refs → ObjectId ` +
          '(vehicle / buyer / assignedTo)',
        );
      }
    } catch (err) {
      this.logger.error('Lead ref-cast migration failed', err instanceof Error ? err.stack : err);
    }
  }
}
