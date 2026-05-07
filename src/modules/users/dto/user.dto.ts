import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength, Matches,
} from 'class-validator';
import { UserRole } from '../schemas/user.schema';

export class CreateUserDto {
  @ApiProperty({ example: 'John' })
  @IsNotEmpty() @IsString() firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsNotEmpty() @IsString() lastName: string;

  @ApiProperty({ example: 'john.doe@cdms.com' })
  @IsEmail() email: string;

  @ApiProperty({ minLength: 8, example: 'P@ssw0rd!' })
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must contain uppercase, lowercase, number/special char',
  })
  password: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.SALES_AGENT })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsOptional() @IsString() phone?: string;

  @ApiPropertyOptional({ example: 'Sales' })
  @IsOptional() @IsString() department?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional({ enum: UserRole }) @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatar?: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsNotEmpty() @IsString() currentPassword: string;
  @ApiProperty({ minLength: 8 })
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must contain uppercase, lowercase, number/special char',
  })
  newPassword: string;
}
