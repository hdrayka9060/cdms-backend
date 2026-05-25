import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export type UserDocument = User & Document;

/**
 * @deprecated Legacy flat-role enum. New users should use `roleId` (ObjectId ref Role).
 * Kept only so the seeder migration can recognize legacy values on existing documents.
 */
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

  /**
   * Reference to a role document in the `roles` collection.
   * Populated reads expose `{ _id, name, description, permissions[] }`.
   */
  @ApiProperty({ description: 'Role ObjectId (ref: Role)' })
  @Prop({ type: Types.ObjectId, ref: 'Role' })
  roleId: Types.ObjectId;

  /**
   * @deprecated Legacy string role enum. Read only — new code writes `roleId`.
   * The roles seeder migrates and `$unset`s this field on boot.
   */
  @Prop({ type: String, enum: UserRole, required: false })
  role?: UserRole;

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
// (Note: email gets a unique index via @Prop({ unique: true }) above; no explicit index here.)
UserSchema.index({ roleId: 1, status: 1 });
