import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Lead, LeadDocument, LeadStatus } from './schemas/lead.schema';

/**
 * Renames the historical `status: 'dropped'` terminal value to `'archived'`.
 *
 * Runs once on boot. Idempotent — does nothing on the second run because the
 * filter no longer matches anything. Failures don't crash the app; the
 * relevant rows just keep their old value and become invisible to API
 * responses (the enum no longer accepts `'dropped'`, so reads would fail
 * validation if not migrated).
 */
@Injectable()
export class LeadsMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeadsMigrator.name);

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
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
}
