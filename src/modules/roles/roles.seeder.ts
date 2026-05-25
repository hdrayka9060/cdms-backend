import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role, RoleDocument } from './schemas/role.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { DEFAULT_ROLES, LEGACY_ROLE_MAP } from '../../common/permissions';

/**
 * Runs once on application bootstrap, AFTER all modules init and BEFORE the
 * HTTP server starts accepting requests.
 *
 *   1. Seed any missing default roles (idempotent — only inserts what's missing).
 *   2. Migrate legacy users (with the old `role: <string>` enum) to the new
 *      `roleId: ObjectId` ref, mapping via LEGACY_ROLE_MAP.
 */
@Injectable()
export class RolesSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesSeeder.name);

  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedDefaultRoles();
      await this.migrateLegacyUsers();
    } catch (err) {
      // Don't crash the app on seed failure — log and continue.
      // (e.g. transient Mongo connection issue at boot.)
      this.logger.error('Roles seeder failed', err instanceof Error ? err.stack : err);
    }
  }

  private async seedDefaultRoles(): Promise<void> {
    let inserted = 0;
    for (const seed of DEFAULT_ROLES) {
      const existing = await this.roleModel.findOne({ name: seed.name });
      if (existing) continue;
      await this.roleModel.create({ ...seed, isSystem: true });
      inserted++;
    }
    if (inserted > 0) {
      this.logger.log(`Seeded ${inserted} default role(s)`);
    }
  }

  private async migrateLegacyUsers(): Promise<void> {
    // Find users with the legacy `role` string field present but no `roleId` yet.
    const legacyUsers = await this.userModel
      .find({
        $and: [
          { role: { $exists: true } },
          { $or: [{ roleId: { $exists: false } }, { roleId: null }] },
        ],
      })
      .lean();

    if (legacyUsers.length === 0) return;

    // Pre-load all seeded roles by name → _id.
    const roles = await this.roleModel.find({ isSystem: true }).lean();
    const nameToId = new Map<string, any>(roles.map((r) => [r.name, r._id]));
    const fallbackId = nameToId.get('Sales Staff');

    let migrated = 0;
    for (const user of legacyUsers) {
      const legacyRole = (user as any).role as string | undefined;
      const targetRoleName = legacyRole ? LEGACY_ROLE_MAP[legacyRole] : undefined;
      const targetRoleId = (targetRoleName && nameToId.get(targetRoleName)) || fallbackId;
      if (!targetRoleId) continue;

      await this.userModel.updateOne(
        { _id: user._id },
        { $set: { roleId: targetRoleId }, $unset: { role: '' } },
      );
      migrated++;
    }
    this.logger.log(`Migrated ${migrated} legacy user(s) to roleId references`);
  }
}
