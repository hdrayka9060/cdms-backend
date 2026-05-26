import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'John' }) @IsNotEmpty() @IsString() firstName: string;
  @ApiProperty({ example: 'Doe' }) @IsNotEmpty() @IsString() lastName: string;
  @ApiProperty({ example: 'admin@cdms.com' }) @IsEmail() email: string;
  @ApiProperty({ example: 'P@ssw0rd!', minLength: 8 })
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password too weak',
  })
  password: string;
  @ApiPropertyOptional({ example: 'My Dealership LLC' }) @IsOptional() @IsString() dealershipName?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'admin@cdms.com' }) @IsEmail() email: string;
  @ApiProperty({ example: 'P@ssw0rd!' }) @IsNotEmpty() @IsString() password: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token issued at login' })
  @IsNotEmpty() @IsString() refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'john@cdms.com' }) @IsEmail() email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Reset token from email link' })
  @IsNotEmpty() @IsString() token: string;
  @ApiProperty({ minLength: 8 })
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password too weak',
  })
  newPassword: string;
}

/**
 * Body for POST /auth/accept-invite. The invitee clicked the link in their
 * email and is setting a password for the first time. Returns access +
 * refresh tokens just like /auth/login — no separate sign-in step.
 */
export class AcceptInviteDto {
  @ApiProperty({ description: 'Raw invite token from the email link' })
  @IsNotEmpty() @IsString() token: string;

  @ApiProperty({ minLength: 8, example: 'P@ssw0rd!' })
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must include uppercase, lowercase, and a number or symbol',
  })
  password: string;

  // Allow invitees to correct their own name/phone before activation — the
  // admin may have spelled it wrong in the invite form.
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
}
