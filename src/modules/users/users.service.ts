import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import { User, UserDocument, UserStatus } from './schemas/user.schema';
import {
  CreateUserDto,
  UpdateUserDto,
  ChangePasswordDto,
  InviteUserDto,
} from './dto/user.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';
import { RolesService } from '../roles/roles.service';
import { ActivityService } from '../activity/activity.service';
import { MailService } from '../mail/mail.service';
import { MessagingService } from '../messaging/messaging.service';

/** 7 days. Long enough that a Friday-afternoon invite still works on Monday. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hash the raw invite token for storage. We use sha256 because lookup is
 * by-equality (no need for bcrypt's deliberate slowness — the raw token is
 * opaque 256-bit random bytes, not a password).
 */
function hashInviteToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly rolesService: RolesService,
    private readonly activity: ActivityService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly messaging: MessagingService,
  ) {}

  // ── Generic CRUD ────────────────────────────────────────────────────────

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
      // Populate role so the frontend can render names + status badges in one
      // round trip (matches the shape the existing useStaff() hook expects).
      this.userModel
        .find(filter)
        .populate('roleId', 'name description')
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(filter),
    ]);

    return new PaginatedResult(data as unknown as UserDocument[], total, page, limit);
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({ _id: id, isDeleted: false })
      // `match: { isDeleted: false }` is a security boundary: a soft-deleted
      // role must NOT hydrate its permissions. When the role is deleted the
      // populate yields `null`, and PermissionsGuard then denies every gated
      // route ("User has no role assigned") instead of granting the deleted
      // role's old permissions.
      .populate({ path: 'roleId', match: { isDeleted: false } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string, includePassword = false): Promise<UserDocument | null> {
    const query = this.userModel
      .findOne({ email: email.toLowerCase(), isDeleted: false })
      .populate({ path: 'roleId', match: { isDeleted: false } });
    if (includePassword) query.select('+password +refreshToken');
    return query.exec();
  }

  /**
   * Update arbitrary user fields. Emits a `role-changed` activity when the
   * roleId changes — otherwise a generic `updated`. We deliberately don't
   * emit both: role change is the headline event and includes any other
   * field changes in meta.
   */
  async update(id: string, dto: UpdateUserDto, actorId?: string): Promise<UserDocument> {
    // Load existing with populated role so we can diff role names.
    const existing = await this.userModel.findOne({ _id: id, isDeleted: false }).populate('roleId');
    if (!existing) throw new NotFoundException('User not found');

    const roleChanged =
      !!dto.roleId &&
      String(dto.roleId) !== String((existing.roleId as any)?._id ?? existing.roleId ?? '');

    const updated = await this.userModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: dto },
      { new: true, runValidators: true },
    ).populate('roleId');
    if (!updated) throw new NotFoundException('User not found');

    // Build the changed-fields list for meta. Cheap & informative for the
    // dashboard activity row tooltip.
    const fieldsChanged = Object.keys(dto).filter((k) => {
      const before = (existing as any)[k];
      const after = (updated as any)[k];
      return String(before) !== String(after);
    });

    try {
      if (roleChanged) {
        const fromRoleName = (existing.roleId as any)?.name ?? '—';
        const toRoleName = (updated.roleId as any)?.name ?? '—';
        await this.activity.log({
          module: 'users',
          action: 'role-changed',
          entity: 'User',
          entityId: updated._id,
          label: `${updated.firstName} ${updated.lastName} → ${toRoleName}`,
          byId: actorId,
          meta: { from: fromRoleName, to: toRoleName, fieldsChanged },
        });
      } else if (fieldsChanged.length > 0) {
        await this.activity.log({
          module: 'users',
          action: 'updated',
          entity: 'User',
          entityId: updated._id,
          label: `${updated.firstName} ${updated.lastName}`,
          byId: actorId,
          meta: { fieldsChanged },
        });
      }
    } catch (err) {
      this.logger.warn(`activity log failed for user update id=${id}: ${err}`);
    }

    return updated;
  }

  async changePassword(id: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userModel.findOne({ _id: id }).select('+password');
    if (!user) throw new NotFoundException('User not found');
    if (!user.password) throw new BadRequestException('Password not set — accept your invite first');

    const valid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    user.password = await bcrypt.hash(dto.newPassword, 12);
    await user.save();
  }

  /**
   * Soft-delete a user. Blocks self-delete (would lock the admin out of
   * their own session immediately). Emits a `deleted` activity.
   */
  async softDelete(id: string, actorId?: string): Promise<void> {
    if (actorId && String(actorId) === String(id)) {
      throw new BadRequestException('You cannot delete your own account');
    }

    // `new: false` returns the pre-delete document so we can name it in the
    // activity row even though the doc is now soft-deleted.
    const user = await this.userModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date(), status: UserStatus.INACTIVE },
      { new: false },
    );
    if (!user) throw new NotFoundException('User not found');

    try {
      await this.activity.log({
        module: 'users',
        action: 'deleted',
        entity: 'User',
        entityId: user._id,
        label: `${user.firstName} ${user.lastName} (${user.email})`,
        byId: actorId,
        meta: { previousStatus: user.status },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for user delete id=${id}: ${err}`);
    }

    // Cascade: drop the removed user from every conversation (direct + group).
    // Surviving members keep the thread with that slot shown as "User left" and
    // the history intact. Best-effort — a messaging hiccup must not block the
    // delete itself.
    try {
      await this.messaging.onUserRemoved(id);
    } catch (err) {
      this.logger.warn(`messaging cascade failed for user delete id=${id}: ${err}`);
    }
  }

  // ── Invite flow ─────────────────────────────────────────────────────────

  /**
   * Create an INVITED user and dispatch the invite email.
   *
   * Atomicity contract:
   *   - If mail dispatch fails (real-mode SMTP rejection), the user row is
   *     hard-deleted and the error is re-thrown to the caller. We never want
   *     a stranded INVITED user with no email + no token in the wild.
   *   - In dev mode (no real SMTP creds), the mail call returns successfully
   *     after logging the link — so the user IS created and can be activated
   *     by copying the link from console.
   *
   * Re-invite semantics:
   *   - If a NON-deleted user with this email exists → 409.
   *   - If a SOFT-DELETED user with this email exists → the old row is
   *     hard-deleted and the new invite proceeds, creating a fresh user
   *     (per "create new user when deleted staff is invited"). Historical
   *     references to the old user._id from other collections become orphan
   *     ids — acceptable because the user was already deactivated and any
   *     audit-feed entries still display the captured `by` name.
   */
  async invite(
    dto: InviteUserDto,
    inviter: { id?: string; name?: string },
  ): Promise<{ user: UserDocument; rawToken: string }> {
    const email = dto.email.toLowerCase();
    const existing = await this.userModel.findOne({ email });
    if (existing) {
      if (!existing.isDeleted) {
        throw new ConflictException('A user with this email already exists');
      }
      // Soft-deleted row — hard-delete so the email is free for a fresh
      // invite. We use deleteOne (not the soft-delete flag) because we want
      // the new invite to be a brand-new user row, not a "restored" one.
      await this.userModel.deleteOne({ _id: existing._id });
      this.logger.log(
        `invite: cleared soft-deleted row email=${email} oldId=${existing._id} to re-invite`,
      );
    }

    // Verify the role exists (otherwise the invitee lands with a broken roleId).
    const role = await this.rolesService.findById(dto.roleId);
    if (!role) throw new NotFoundException('Role not found');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashInviteToken(rawToken);
    const expires = new Date(Date.now() + INVITE_TTL_MS);

    const user = new this.userModel({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email,
      roleId: new Types.ObjectId(dto.roleId),
      phone: dto.phone,
      department: dto.department,
      status: UserStatus.INVITED,
      inviteToken: tokenHash,
      inviteTokenExpires: expires,
      // password intentionally absent
    });
    const saved = await user.save();

    // Dispatch the email AND wait for confirmation. Real-mode failures throw
    // MailDeliveryError; dev mode returns success after logging the link.
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:8080';
    const inviteUrl = `${frontendUrl.replace(/\/$/, '')}/accept-invite?token=${rawToken}`;
    try {
      await this.mail.sendInvite({
        to: saved.email,
        firstName: saved.firstName,
        inviterName: inviter.name,
        roleName: (role as any).name,
        inviteUrl,
      });
    } catch (mailErr) {
      // Roll back: the user can't activate without the token in the email.
      // Hard-delete so the email address is free to be re-invited once the
      // admin fixes the SMTP issue. Wrapped in its own try/catch so a
      // mongo blip on the cleanup doesn't mask the original mail error.
      try {
        await this.userModel.deleteOne({ _id: saved._id });
      } catch (cleanupErr) {
        this.logger.error(
          `invite rollback FAILED for email=${email} id=${saved._id} — ` +
          `manual cleanup required: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
        );
      }
      // Re-throw so the controller surfaces a 503 to the frontend toast.
      throw mailErr;
    }

    // Audit log only AFTER mail succeeded — a failed invite shouldn't
    // appear in the activity feed as if it had happened.
    try {
      await this.activity.log({
        module: 'users',
        action: 'invited',
        entity: 'User',
        entityId: saved._id,
        label: `${saved.firstName} ${saved.lastName} (${saved.email})`,
        byId: inviter.id,
        meta: { roleId: dto.roleId, roleName: (role as any).name },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for user invite id=${saved._id}: ${err}`);
    }

    return { user: saved, rawToken };
  }

  /**
   * Look up an invitation by raw token. Used by the public
   * GET /auth/invite/:token endpoint so the frontend can show the invitee's
   * name/email on the accept-password page.
   */
  async findByInviteToken(rawToken: string): Promise<UserDocument | null> {
    const tokenHash = hashInviteToken(rawToken);
    return this.userModel
      .findOne({
        inviteToken: tokenHash,
        inviteTokenExpires: { $gt: new Date() },
        isDeleted: false,
        status: UserStatus.INVITED,
      })
      .select('+inviteToken +inviteTokenExpires')
      .populate('roleId', 'name');
  }

  /**
   * Consume the invite: set password, flip to ACTIVE, clear invite token.
   * Returns the activated user (with populated role).
   */
  async acceptInvite(
    rawToken: string,
    newPassword: string,
    profileExtras?: { firstName?: string; lastName?: string; phone?: string },
  ): Promise<UserDocument> {
    const tokenHash = hashInviteToken(rawToken);
    // Selecting +password so the next save() persists the hash field.
    const user = await this.userModel
      .findOne({
        inviteToken: tokenHash,
        inviteTokenExpires: { $gt: new Date() },
        isDeleted: false,
        status: UserStatus.INVITED,
      })
      .select('+inviteToken +inviteTokenExpires +password');
    if (!user) throw new BadRequestException('Invite token is invalid or expired');

    user.password = await bcrypt.hash(newPassword, 12);
    user.status = UserStatus.ACTIVE;
    user.inviteToken = undefined;
    user.inviteTokenExpires = undefined;
    if (profileExtras?.firstName) user.firstName = profileExtras.firstName;
    if (profileExtras?.lastName) user.lastName = profileExtras.lastName;
    if (profileExtras?.phone) user.phone = profileExtras.phone;
    await user.save();

    try {
      await this.activity.log({
        module: 'users',
        action: 'invite-accepted',
        entity: 'User',
        entityId: user._id,
        label: `${user.firstName} ${user.lastName} (${user.email})`,
        byId: user._id,
        meta: {},
      });
    } catch (err) {
      this.logger.warn(`activity log failed for invite-accept id=${user._id}: ${err}`);
    }

    // Re-fetch with populated role so the caller (AuthService.acceptInvite)
    // has the same shape it would get from login.
    return this.findById(user._id.toString());
  }

  // ── Bulk invite ─────────────────────────────────────────────────────────

  /**
   * Bulk-invite from a CSV. Columns: firstName, lastName, email, phone,
   * department, role (role = role NAME — looked up case-insensitively
   * against the roles collection). `phone` and `department` are optional.
   * Each row is processed sequentially.
   *
   * Atomicity per row: each row calls `invite()` which is itself transactional
   * — if mail dispatch fails for a row, that row's user is hard-deleted and
   * the failure surfaces in `errors[]`. Successful rows have both a DB row
   * and a sent invite email; failed rows have neither (no orphan invitees).
   *
   * Note: this is slower than fire-and-forget would be (one SMTP round-trip
   * per row, not parallelized), but the user explicitly chose "don't add
   * that user in db if mail fails" — which requires awaiting per row to
   * know whether to roll back.
   *
   * Returns counts + per-row errors. Never throws unless the CSV is
   * fundamentally unparseable.
   */
  async bulkInvite(
    csvBuffer: Buffer,
    inviter: { id?: string; name?: string },
  ): Promise<{ created: number; invited: string[]; errors: string[] }> {
    let records: any[];
    try {
      records = parse(csvBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err) {
      throw new BadRequestException(
        `CSV could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Cache roles by lower-cased name so we don't hit the DB per row.
    const allRoles = await this.rolesService.findAll();
    const rolesByName = new Map<string, any>(
      allRoles.map((r: any) => [String(r.name).toLowerCase(), r]),
    );

    const errors: string[] = [];
    const invited: string[] = [];
    let created = 0;

    // Process sequentially so per-row failures stay attributable. Mail
    // dispatches are fire-and-forget (invite() already does `void mail.send`).
    let rowIndex = 1; // header is row 0
    for (const record of records) {
      rowIndex++;
      const email = String(record.email ?? '').trim();
      const firstName = String(record.firstName ?? '').trim();
      const lastName = String(record.lastName ?? '').trim();
      const roleNameRaw = String(record.role ?? '').trim();
      const phone = String(record.phone ?? '').trim() || undefined;
      const department = String(record.department ?? '').trim() || undefined;

      if (!email || !firstName || !lastName || !roleNameRaw) {
        errors.push(`Row ${rowIndex}: missing required field (firstName/lastName/email/role)`);
        continue;
      }

      const role = rolesByName.get(roleNameRaw.toLowerCase());
      if (!role) {
        errors.push(
          `Row ${rowIndex} (${email}): role "${roleNameRaw}" not found. Valid: ${[...rolesByName.values()].map((r: any) => r.name).join(', ')}`,
        );
        continue;
      }

      try {
        await this.invite(
          {
            firstName,
            lastName,
            email,
            phone,
            department,
            roleId: String(role._id),
          },
          inviter,
        );
        created++;
        invited.push(email);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Row ${rowIndex} (${email}): ${msg}`);
      }
    }

    try {
      // One summary row in the activity feed for the whole bulk operation.
      // (Each row's individual invite() also writes a row, so the feed shows
      // the per-user entries plus this aggregate.)
      await this.activity.log({
        module: 'users',
        action: 'invited',
        entity: 'User',
        label: `Bulk invite — ${created} invited, ${errors.length} skipped`,
        byId: inviter.id,
        meta: { count: created, errors: errors.length, source: 'bulk' },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for bulk invite: ${err}`);
    }

    return { created, invited, errors };
  }

  // ── Token persistence helpers (used by AuthService) ─────────────────────

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
