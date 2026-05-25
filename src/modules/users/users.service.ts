import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument, UserStatus } from './schemas/user.schema';
import { CreateUserDto, UpdateUserDto, ChangePasswordDto } from './dto/user.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) {}

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const exists = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (exists) throw new ConflictException('Email already registered');

    const hashed = await bcrypt.hash(dto.password, 12);
    const user = new this.userModel({ ...dto, password: hashed });
    return user.save();
  }

  async findAll(query: PaginationDto): Promise<PaginatedResult<UserDocument>> {
    const { page = 1, limit = 20, search, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;

    const filter: FilterQuery<UserDocument> = { isDeleted: false };
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const sortObj: any = {};
    if (sort.startsWith('-')) sortObj[sort.slice(1)] = -1;
    else sortObj[sort] = 1;

    const [data, total] = await Promise.all([
      this.userModel.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      this.userModel.countDocuments(filter),
    ]);

    return new PaginatedResult(data as unknown as UserDocument[], total, page, limit);
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({ _id: id, isDeleted: false })
      .populate('roleId');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string, includePassword = false): Promise<UserDocument | null> {
    const query = this.userModel
      .findOne({ email: email.toLowerCase(), isDeleted: false })
      .populate('roleId');
    if (includePassword) query.select('+password +refreshToken');
    return query.exec();
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDocument> {
    const user = await this.userModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: dto },
      { new: true, runValidators: true },
    );
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async changePassword(id: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userModel.findOne({ _id: id }).select('+password');
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    user.password = await bcrypt.hash(dto.newPassword, 12);
    await user.save();
  }

  async softDelete(id: string): Promise<void> {
    const user = await this.userModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date(), status: UserStatus.INACTIVE },
    );
    if (!user) throw new NotFoundException('User not found');
  }

  async setRefreshToken(id: string, token: string | null): Promise<void> {
    const hash = token ? await bcrypt.hash(token, 10) : null;
    await this.userModel.findByIdAndUpdate(id, { refreshToken: hash });
  }

  async validateRefreshToken(id: string, token: string): Promise<boolean> {
    const user = await this.userModel.findById(id).select('+refreshToken');
    if (!user?.refreshToken) return false;
    return bcrypt.compare(token, user.refreshToken);
  }

  async setResetToken(email: string, token: string, expires: Date): Promise<void> {
    await this.userModel.findOneAndUpdate(
      { email },
      { resetPasswordToken: token, resetPasswordExpires: expires },
    );
  }

  async findByResetToken(token: string): Promise<UserDocument | null> {
    return this.userModel.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+resetPasswordToken +resetPasswordExpires');
  }

  async resetPassword(id: string, newPassword: string): Promise<void> {
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.userModel.findByIdAndUpdate(id, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordExpires: null,
    });
  }
}
