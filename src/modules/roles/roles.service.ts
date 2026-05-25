import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role, RoleDocument } from './schemas/role.schema';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(@InjectModel(Role.name) private readonly model: Model<RoleDocument>) {}

  async create(dto: CreateRoleDto): Promise<RoleDocument> {
    const exists = await this.model.findOne({ name: dto.name, isDeleted: false });
    if (exists) throw new ConflictException('Role name already exists');
    return new this.model(dto).save();
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
    const role = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: dto },
      { new: true, runValidators: true },
    );
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async remove(id: string): Promise<void> {
    const role = await this.model.findOne({ _id: id, isDeleted: false });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }
    role.isDeleted = true;
    await role.save();
  }
}
