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
 *   3. Drop the stale unique (buyer, vehicle) partial index. It filtered on
 *      { isDeleted: false } only, so an ARCHIVED lead still occupied the slot
 *      and blocked creating a fresh lead for the same buyer×vehicle (E11000)
 *      before the status-aware Guard 2 could allow it. Uniqueness is now
 *      guard-enforced only; the index is removed from the schema and dropped
 *      here for databases created before the change.
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
    await this.dropStaleBuyerVehicleUniqueIndex();
  }

  /**
   * Drop the legacy unique (buyer, vehicle) partial index if present. Its
   * partialFilterExpression was { isDeleted: false }, which is NOT status-aware:
   * an archived lead (isDeleted: false) kept holding the buyer×vehicle slot, so
   * a new lead for the same pair failed with a duplicate-key error even though
   * Guard 2 in LeadsService.create would have allowed it. Uniqueness is now
   * enforced solely by that guard. Matches by key pattern so it works whatever
   * the auto-generated index name is. No-op once the index is gone.
   */
  private async dropStaleBuyerVehicleUniqueIndex(): Promise<void> {
    const collection = this.leadModel.collection;
    try {
      const indexes = await collection.indexes();
      const stale = indexes.find(
        (ix) =>
          ix.unique === true &&
          ix.key &&
          Object.keys(ix.key).length === 2 &&
          ix.key.buyer === 1 &&
          ix.key.vehicle === 1,
      );
      if (stale?.name) {
        await collection.dropIndex(stale.name);
        this.logger.log(`Dropped stale unique index '${stale.name}' on (buyer, vehicle)`);
      }
    } catch (err) {
      this.logger.error(
        'Dropping stale (buyer, vehicle) unique index failed',
        err instanceof Error ? err.stack : err,
      );
    }
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
