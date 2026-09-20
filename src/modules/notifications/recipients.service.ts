import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument, UserStatus } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../roles/schemas/role.schema';

/**
 * A target audience for a notification. The resolver turns this into a concrete
 * set of active user ids. Recipient model = **role + assignee** (the locked
 * decision): the assignee always gets it; otherwise everyone whose role grants
 * a given module:action.
 */
export interface RecipientSpec {
  /** Explicit user ids (e.g. a specific rep). */
  userIds?: string[];
  /** The record's assignee. */
  assigneeId?: string | null;
  /** Everyone whose role grants any of these module:action pairs. */
  roleModules?: { module: string; action: string }[];
  /** Never notify these (e.g. the actor who caused the event). */
  excludeUserIds?: string[];
}

@Injectable()
export class RecipientsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roles: Model<RoleDocument>,
  ) {}

  /**
   * Resolve a spec to a deduped list of **active, non-deleted** user ids, with
   * excludes removed. Every path is funneled through a final active-user query
   * so we never notify an invited/inactive/removed account — even one passed
   * explicitly or set as an assignee.
   */
  async resolve(spec: RecipientSpec): Promise<string[]> {
    const candidates = new Set<string>();
    (spec.userIds ?? []).forEach((id) => id && candidates.add(String(id)));
    if (spec.assigneeId) candidates.add(String(spec.assigneeId));
    for (const id of await this.usersByRoleModules(spec.roleModules ?? [])) {
      candidates.add(id);
    }

    const exclude = new Set((spec.excludeUserIds ?? []).map(String));
    const ids = [...candidates]
      .filter((id) => !exclude.has(id) && Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (!ids.length) return [];

    const active = await this.users
      .find({ _id: { $in: ids }, isDeleted: false, status: UserStatus.ACTIVE })
      .select('_id');
    return active.map((u) => String(u._id));
  }

  /** User ids whose role grants ANY of the given module:action pairs. */
  private async usersByRoleModules(
    mods: { module: string; action: string }[],
  ): Promise<string[]> {
    if (!mods.length) return [];
    const roles = await this.roles
      .find({
        isDeleted: false,
        $or: mods.map((m) => ({
          permissions: { $elemMatch: { module: m.module, actions: m.action } },
        })),
      })
      .select('_id');
    if (!roles.length) return [];
    const users = await this.users
      .find({
        roleId: { $in: roles.map((r) => r._id) },
        isDeleted: false,
        status: UserStatus.ACTIVE,
      })
      .select('_id');
    return users.map((u) => String(u._id));
  }
}
