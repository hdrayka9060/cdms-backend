import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role, RoleDocument } from './schemas/role.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectModel(Role.name) private readonly model: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async create(dto: CreateRoleDto): Promise<RoleDocument> {
    const exists = await this.model.findOne({ name: dto.name, isDeleted: false });
    if (exists) throw new ConflictException('Role name already exists');

    // Sanitize permissions: remove any entries with empty or invalid actions arrays
    const cleaned = {
      ...dto,
      permissions: (dto.permissions ?? []).filter(
        (p) => Array.isArray(p.actions) && p.actions.length > 0,
      ),
    } as CreateRoleDto;

    return new this.model(cleaned).save();
  }

  async findAll(): Promise<RoleDocument[]> {
    return this.model.find({ isDeleted: false }).sort({ isSystem: -1, name: 1 });
  }

  async findById(id: string): Promise<RoleDocument> {
    const role = await this.model.findOne({ _id: id, isDeleted: false });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async findByName(name: string): Promise<RoleDocument | null> {
    return this.model.findOne({ name, isDeleted: false });
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleDocument> {
    const toSet: Partial<UpdateRoleDto> = { ...dto };
    if (dto.permissions) {
      toSet.permissions = dto.permissions.filter((p) => Array.isArray(p.actions) && p.actions.length > 0);
    }

    const role = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: toSet },
      { new: true, runValidators: true },
    );
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  /**
   * Soft-delete a role.
   *
   * System roles ARE deletable (the old `isSystem` block was removed) — the
   * only guards are:
   *   1. Self-lockout — you cannot delete the role assigned to your own
   *      account (mirrors the self-delete guard on users), or you'd 403
   *      yourself out of role management on the next request.
   *   2. Reassign-first — deletion is blocked while any active user still
   *      holds the role, so nobody is left with a dangling roleId. The admin
   *      reassigns them from the Staff page, then deletes.
   *
   * @param actorRoleId the caller's own roleId, for the self-lockout check.
   */
  async remove(id: string, actorRoleId?: string): Promise<void> {
    const role = await this.model.findOne({ _id: id, isDeleted: false });
    if (!role) throw new NotFoundException('Role not found');

    if (actorRoleId && String(actorRoleId) === String(role._id)) {
      throw new ForbiddenException(
        'You cannot delete the role assigned to your own account',
      );
    }

    const assignedCount = await this.userModel.countDocuments({
      roleId: role._id,
      isDeleted: false,
    });
    if (assignedCount > 0) {
      throw new ConflictException(
        `${assignedCount} staff ${assignedCount === 1 ? 'member is' : 'members are'} still assigned to this role. Reassign them from the Staff page before deleting.`,
      );
    }

    role.isDeleted = true;
    await role.save();
  }
}
