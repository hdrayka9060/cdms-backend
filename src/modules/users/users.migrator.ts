import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

/**
 * Idempotent boot-time data fixups for the `users` collection.
 *
 * Currently runs ONE migration:
 *   roleId: string → ObjectId
 *
 * Why: the schema originally declared `@Prop({ type: Types.ObjectId, ref: 'Role' })`.
 * That degrades to Mongoose's `Mixed` type (silent no-cast), so any user row
 * created before this fix has `roleId` stored as a plain string. The
 * PermissionsGuard happens to work today because it goes through `populate`
 * which Mongoose auto-coerces — but ANY direct equality query
 * (`{ roleId: new Types.ObjectId(id) }`) misses string-ref rows. Same latent
 * bug we caught on Lead.vehicle/buyer.
 *
 * The schema is now `Schema.Types.ObjectId` so new writes are typed
 * correctly; this migrator backfills existing rows. Re-running is a no-op
 * (the `$type: 'string'` filter matches zero rows after the first pass).
 */
@Injectable()
export class UsersMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsersMigrator.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.castRoleIdToObjectId();
  }

  private async castRoleIdToObjectId(): Promise<void> {
    const collection = this.userModel.collection;
    try {
      const result = await collection.updateMany(
        { roleId: { $type: 'string' } },
        [
          {
            $set: {
              roleId: {
                $cond: [
                  { $eq: [{ $type: '$roleId' }, 'string'] },
                  { $toObjectId: '$roleId' },
                  '$roleId',
                ],
              },
            },
          },
        ],
      );
      if (result.modifiedCount > 0) {
        this.logger.log(`Migrated ${result.modifiedCount} user(s): roleId string → ObjectId`);
      }
    } catch (err) {
      // Never crash the app on migrator failure.
      this.logger.error(
        'User roleId-cast migration failed',
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
