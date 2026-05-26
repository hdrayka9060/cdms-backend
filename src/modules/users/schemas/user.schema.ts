import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
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
  /** Email verified, password set, can log in. */
  ACTIVE = 'active',
  /** Soft-deactivated. Login rejected. Used by softDelete and any future "deactivate but keep" flow. */
  INACTIVE = 'inactive',
  /** Admin-initiated lockout. Login rejected. Reserved for future moderation tooling. */
  SUSPENDED = 'suspended',
  /**
   * Awaiting first-time password setup. Created by POST /users/invite — the
   * row has no password (and login is blocked by the status check) until the
   * user clicks the invite link and accepts via POST /auth/accept-invite,
   * which flips status to ACTIVE.
   */
  INVITED = 'invited',
}

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @ApiProperty() @Prop({ required: true, trim: true }) firstName: string;
  @ApiProperty() @Prop({ required: true, trim: true }) lastName: string;

  @ApiProperty()
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  /**
   * Password may be absent for INVITED users — it's set when the user accepts
   * the invite. Login blocks both "no password" and "status != ACTIVE" so an
   * invited row can't be logged into by guessing.
   */
  @Prop({ required: false, select: false }) password?: string;

  /**
   * Reference to a role document in the `roles` collection.
   * Populated reads expose `{ _id, name, description, permissions[] }`.
   *
   * NOTE: `type: MongooseSchema.Types.ObjectId` (the schema-type API) not
   * `Types.ObjectId` (the runtime class). The latter silently degrades to
   * Mixed and stops casting strings — the same bug we fixed on Lead.
   */
  @ApiProperty({ description: 'Role ObjectId (ref: Role)' })
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Role' })
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

  // ── Invite flow ─────────────────────────────────────────────────────────
  // `inviteToken` stores a sha256 hash of the raw token emailed to the user.
  // We use sha256 (not bcrypt) because invite lookups are by-hash equality —
  // bcrypt's deliberate slowness costs us nothing here and makes the read
  // path heavy. The raw token is opaque random bytes, not a password, so the
  // attacker's job is brute-force search of a 256-bit space — sha256 is fine.
  // `inviteTokenExpires` is checked alongside; both fields cleared on accept.
  @Prop({ select: false }) inviteToken?: string;
  @Prop({ select: false }) inviteTokenExpires?: Date;

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
