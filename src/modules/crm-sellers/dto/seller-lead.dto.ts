import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty, IsString, IsEmail, IsNumber, IsEnum, IsOptional, IsDateString, Min, IsArray,
  ValidateNested, IsInt, Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SellerLeadStage } from '../schemas/seller-lead.schema';
import { FuelType, Transmission, VehicleStatus, HostingType } from '../../inventory/schemas/vehicle.schema';

/**
 * One vehicle the seller is offering. Maps to a row in the `vehicles` (inventory)
 * collection on save. Mirrors a subset of CreateVehicleDto — kept independent so
 * we can evolve the seller intake form without coupling to inventory field churn.
 */
export class SellerVehicleInputDto {
  @ApiProperty({ example: '2022 Toyota Camry XSE' }) @IsNotEmpty() @IsString() title: string;
  @ApiProperty({ example: 'Toyota' }) @IsNotEmpty() @IsString() company: string;
  @ApiProperty({ example: 'Camry' }) @IsNotEmpty() @IsString() model: string;
  @ApiProperty({ example: 2022, minimum: 1900, maximum: 2100 }) @IsInt() @Min(1900) @Max(2100) year: number;
  @ApiProperty({ example: 35000 }) @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) km?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) owners?: number;
  @ApiPropertyOptional({ enum: FuelType }) @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @ApiPropertyOptional({ enum: Transmission }) @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional({ enum: HostingType }) @IsOptional() @IsEnum(HostingType) hosting?: HostingType;
}

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

export class ScheduleInspectionDto {
  @ApiProperty({ description: 'ISO date-time for inspection' })
  @IsDateString() inspectionDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ description: 'Vehicle ObjectId to inspect (used for the activity label)' })
  @IsOptional() @IsString() vehicleId?: string;
  @ApiPropertyOptional({ description: 'Staff member (User ObjectId) responsible for the inspection' })
  @IsOptional() @IsString() assignedTo?: string;
}
