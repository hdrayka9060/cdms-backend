import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export type UserDocument = User & Document;

export enum UserRole {
  ADMIN = 'admin',
  MANAGER = 'manager',
  SALES_AGENT = 'sales_agent',
  SUPPORT = 'support',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @ApiProperty() @Prop({ required: true, trim: true }) firstName: string;
  @ApiProperty() @Prop({ required: true, trim: true }) lastName: string;

  @ApiProperty()
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false }) password: string;

  @ApiProperty({ enum: UserRole })
  @Prop({ type: String, enum: UserRole, default: UserRole.SALES_AGENT })
  role: UserRole;

  @ApiProperty({ enum: UserStatus })
  @Prop({ type: String, enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @ApiProperty() @Prop({ default: '' }) phone: string;
  @ApiProperty() @Prop({ default: '' }) avatar: string;
  @ApiProperty() @Prop({ default: '' }) department: string;

  // Refresh token hash stored for invalidation
  @Prop({ select: false }) refreshToken: string;

  // Password reset
  @Prop({ select: false }) resetPasswordToken: string;
  @Prop({ select: false }) resetPasswordExpires: Date;

  // Soft delete
  @ApiProperty() @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  // Timestamps (auto)
  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Virtual: full name
UserSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Index for fast lookups
UserSchema.index({ email: 1 });
UserSchema.index({ role: 1, status: 1 });
