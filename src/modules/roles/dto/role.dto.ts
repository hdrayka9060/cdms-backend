import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppModule, PermissionAction } from '../../../common/permissions';

export class PermissionEntryDto {
  @ApiProperty({ enum: AppModule, example: AppModule.INVENTORY })
  @IsEnum(AppModule)
  module: AppModule;

  @ApiProperty({ enum: PermissionAction, isArray: true, example: [PermissionAction.VIEW, PermissionAction.EDIT] })
  @IsArray()
  @IsEnum(PermissionAction, { each: true })
  actions: PermissionAction[];
}

export class CreateRoleDto {
  @ApiProperty({ example: 'Finance Manager' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Handles BHPH loans and accounting reports' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ type: [PermissionEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionEntryDto)
  permissions: PermissionEntryDto[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ type: [PermissionEntryDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionEntryDto)
  permissions?: PermissionEntryDto[];
}
