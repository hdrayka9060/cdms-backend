import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty, IsString, IsEmail, IsNumber, IsEnum, IsOptional, IsDateString, Min, IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SellerLeadStage } from '../schemas/seller-lead.schema';
import { CreateVehicleDto } from '../../inventory/dto/vehicle.dto';

/**
 * One vehicle the seller is offering. Maps to a row in the `vehicles` (inventory)
 * collection on save. Extends the canonical CreateVehicleDto so the seller intake
 * form accepts EXACTLY the same fields as the Inventory "Add Vehicle" form —
 * including trim / engine / drivetrain / engineSize / interiorColor / doors.
 *
 * Why extend instead of re-declaring a subset: the global ValidationPipe runs
 * with `forbidNonWhitelisted: true`, so any field the shared VehicleFormDialog
 * emits that isn't whitelisted here 400s the whole request. Inheriting the full
 * DTO keeps the two forms permanently in lockstep. The `seller` field carried on
 * CreateVehicleDto is ignored here — InventoryService.create overrides it with
 * the seller id from the route/parent.
 */
export class SellerVehicleInputDto extends CreateVehicleDto {}

export class CreateSellerLeadDto {
  @ApiProperty() @IsNotEmpty() @IsString() sellerName: string;
  @ApiProperty() @IsEmail() sellerEmail: string;
  @ApiProperty() @IsNotEmpty() @IsString() sellerPhone: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  // Address
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zipCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;

  // One-or-more vehicles to create + link at seller creation time. Each entry
  // becomes a real row in the inventory collection.
  @ApiPropertyOptional({ type: [SellerVehicleInputDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SellerVehicleInputDto)
  vehicles?: SellerVehicleInputDto[];
}

export class UpdateSellerLeadDto {
  @ApiPropertyOptional() @IsOptional() @IsString() sellerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() sellerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sellerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zipCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional({ enum: SellerLeadStage }) @IsOptional() @IsEnum(SellerLeadStage) stage?: SellerLeadStage;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() inspectionDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) askingPrice?: number;
}

export class CommunicateDto {
  @ApiProperty({ enum: ['email', 'sms', 'whatsapp', 'call'] })
  @IsEnum(['email', 'sms', 'whatsapp', 'call'])
  channel: string;

  @ApiProperty({ description: 'Message content or call notes' })
  @IsNotEmpty() @IsString() message: string;
}

/** Edit an existing logged communication. Both fields optional — send what changed. */
export class UpdateCommunicateDto {
  @ApiPropertyOptional({ enum: ['email', 'sms', 'whatsapp', 'call'] })
  @IsOptional() @IsEnum(['email', 'sms', 'whatsapp', 'call']) channel?: string;

  @ApiPropertyOptional({ description: 'Updated message content or call notes' })
  @IsOptional() @IsNotEmpty() @IsString() message?: string;
}

export class ScheduleInspectionDto {
  @ApiProperty({ description: 'ISO date-time for inspection' })
  @IsDateString() inspectionDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ description: 'Vehicle ObjectId to inspect (used for the activity label)' })
  @IsOptional() @IsString() vehicleId?: string;
  @ApiPropertyOptional({ description: 'Staff member (User ObjectId) responsible for the inspection' })
  @IsOptional() @IsString() assignedTo?: string;
}
