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
    let reconciled = 0;
    for (const seed of DEFAULT_ROLES) {
      const existing = await this.roleModel.findOne({ name: seed.name });
      if (!existing) {
        await this.roleModel.create({ ...seed, isSystem: true });
        inserted++;
        continue;
      }

      // Reconciliation pass for system roles only: ensure each MODULE in the
      // seed exists on the role and includes at least the seeded actions.
      // We never *remove* actions admins may have added, and we never touch
      // non-system roles (those are admin-managed custom roles).
      //
      // Why this matters: when we extend a default role's responsibilities
      // (e.g. adding Inventory:view to Marketing so /dealer-website can
      // fetch vehicles), existing deployments would silently miss the
      // permission until the admin manually re-edited the role. This loop
      // makes the seed the canonical floor for system roles.
      if (!existing.isSystem) continue;

      const merged: { module: string; actions: string[] }[] = (existing.permissions ?? []).map((p: any) => ({
        module: p.module,
        actions: [...(p.actions ?? [])],
      }));
      let dirty = false;
      for (const seedPerm of seed.permissions) {
        let row = merged.find((m) => m.module === seedPerm.module);
        if (!row) {
          row = { module: seedPerm.module, actions: [] };
          merged.push(row);
          dirty = true;
        }
        for (const a of seedPerm.actions) {
          if (!row.actions.includes(a)) {
            row.actions.push(a);
            dirty = true;
          }
        }
      }
      if (dirty) {
        await this.roleModel.updateOne({ _id: existing._id }, { $set: { permissions: merged } });
        reconciled++;
      }
    }
    if (inserted > 0) this.logger.log(`Seeded ${inserted} default role(s)`);
    if (reconciled > 0) this.logger.log(`Reconciled ${reconciled} system role(s) with updated default permissions`);
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
