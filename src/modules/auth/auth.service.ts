import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { RolesService } from '../roles/roles.service';
import { MailService } from '../mail/mail.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  AcceptInviteDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private rolesService: RolesService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
  ) {}

  async register(dto: RegisterDto) {
    // Public self-registration is a ONE-TIME bootstrap: it creates the very
    // first user (assigned the seeded "Admin" role) and is permanently disabled
    // thereafter. Without this gate, `/auth/register` (a @Public route) would
    // let anyone on the internet mint themselves an admin account. All further
    // staff are created via `POST /users` by an admin with an explicit roleId.
    if ((await this.usersService.count()) > 0) {
      throw new ForbiddenException(
        'Public registration is disabled. Ask an administrator to create your account.',
      );
    }

    const adminRole = await this.rolesService.findByName('Admin');
    if (!adminRole) {
      throw new ServiceUnavailableException(
        'System not initialized — default roles missing. Please restart the server.',
      );
    }

    const user = await this.usersService.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: dto.password,
      roleId: adminRole._id.toString(),
    });

    // Re-fetch with populated role so the response includes role details.
    const populated = await this.usersService.findById(user._id.toString());

    const tokens = await this.generateTokens(populated._id.toString(), populated.email);
    await this.usersService.setRefreshToken(populated._id.toString(), tokens.refreshToken);

    const { password, ...userData } = (populated as any).toObject();
    return { user: userData, ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email, true);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    // INVITED users have no password yet — block with the same generic message
    // so we don't leak account-existence info beyond what's necessary.
    if (!user.password) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.status !== 'active') {
      throw new UnauthorizedException('Account is inactive or suspended');
    }

    const tokens = await this.generateTokens(user._id.toString(), user.email);
    await this.usersService.setRefreshToken(user._id.toString(), tokens.refreshToken);

    const { password, refreshToken, ...userData } = (user as any).toObject();
    return { user: userData, ...tokens };
  }

  async refreshTokens(dto: RefreshTokenDto) {
    try {
      const payload = this.jwtService.verify(dto.refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });

      const valid = await this.usersService.validateRefreshToken(payload.sub, dto.refreshToken);
      if (!valid) throw new UnauthorizedException('Invalid refresh token');

      const user = await this.usersService.findById(payload.sub);
      const tokens = await this.generateTokens(user._id.toString(), user.email);
      await this.usersService.setRefreshToken(user._id.toString(), tokens.refreshToken);

      return tokens;
    } catch (_e) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async logout(userId: string) {
    await this.usersService.setRefreshToken(userId, null);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      // Return success even if email not found (security: don't leak info)
      return { message: 'If the email exists, a reset link has been sent' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await this.usersService.setResetToken(dto.email, token, expires);

    // Dispatch the reset email. Mail service swallows its own errors so this
    // can't reject the request.
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:8080';
    const resetUrl = `${frontendUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
    void this.mailService.sendPasswordReset({
      to: user.email,
      firstName: user.firstName,
      resetUrl,
    });

    return { message: 'If the email exists, a reset link has been sent' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.usersService.findByResetToken(dto.token);
    if (!user) throw new BadRequestException('Invalid or expired reset token');

    await this.usersService.resetPassword(user._id.toString(), dto.newPassword);
    await this.usersService.setRefreshToken(user._id.toString(), null); // invalidate all sessions
    return { message: 'Password reset successfully. Please log in.' };
  }

  /**
   * Validate an invite token and return the invitee's metadata so the
   * frontend can render a "You've been invited to <dealership> as <role>"
   * welcome screen on the accept-password page. Public endpoint — the token
   * itself is the auth.
   */
  async validateInvite(rawToken: string) {
    const user = await this.usersService.findByInviteToken(rawToken);
    if (!user) {
      throw new NotFoundException('Invite is invalid, expired, or already used');
    }
    const role: any = user.roleId;
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roleName: role?.name ?? null,
    };
  }

  /**
   * Consume an invite: set password, flip status to ACTIVE, clear token,
   * and issue access + refresh tokens — same shape as /auth/login so the
   * frontend can route directly to the dashboard.
   */
  async acceptInvite(dto: AcceptInviteDto) {
    const activated = await this.usersService.acceptInvite(dto.token, dto.password, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
    });

    const tokens = await this.generateTokens(activated._id.toString(), activated.email);
    await this.usersService.setRefreshToken(activated._id.toString(), tokens.refreshToken);

    const { password, refreshToken, inviteToken, inviteTokenExpires, ...userData } =
      (activated as any).toObject();
    return { user: userData, ...tokens };
  }

  private async generateTokens(userId: string, email: string) {
    // Note: role/permissions are NOT embedded in the JWT — they're re-loaded from the
    // DB on every request by JwtStrategy.validate(). This keeps permissions fresh after
    // role edits (at the cost of a populate per request, fine at our scale).
    const payload = { sub: userId, email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_ACCESS_SECRET'),
        expiresIn: this.configService.get('JWT_ACCESS_EXPIRES_IN', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
