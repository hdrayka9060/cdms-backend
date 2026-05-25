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
