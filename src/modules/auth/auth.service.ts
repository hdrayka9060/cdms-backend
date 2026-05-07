import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto, RefreshTokenDto, ForgotPasswordDto, ResetPasswordDto } from './dto/auth.dto';
import { UserRole } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const user = await this.usersService.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: dto.password,
      role: UserRole.ADMIN,
    });

    const tokens = await this.generateTokens(user._id.toString(), user.email, user.role);
    await this.usersService.setRefreshToken(user._id.toString(), tokens.refreshToken);

    const { password, ...userData } = (user as any).toObject();
    return { user: userData, ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email, true);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.status !== 'active') {
      throw new UnauthorizedException('Account is inactive or suspended');
    }

    const tokens = await this.generateTokens(user._id.toString(), user.email, user.role);
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
      const tokens = await this.generateTokens(user._id.toString(), user.email, user.role);
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

    // In production: send email with token
    // await this.mailService.sendPasswordReset(user.email, token);

    return { message: 'If the email exists, a reset link has been sent' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.usersService.findByResetToken(dto.token);
    if (!user) throw new BadRequestException('Invalid or expired reset token');

    await this.usersService.resetPassword(user._id.toString(), dto.newPassword);
    await this.usersService.setRefreshToken(user._id.toString(), null); // invalidate all sessions
    return { message: 'Password reset successfully. Please log in.' };
  }

  private async generateTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };

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
