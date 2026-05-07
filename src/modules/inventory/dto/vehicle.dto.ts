import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty, IsString, IsNumber, IsEnum, IsOptional, IsArray, Min, Max, IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleStatus, HostingType, FuelType, Transmission } from '../schemas/vehicle.schema';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class CreateVehicleDto {
  @ApiProperty({ example: 'DL01AB1234' }) @IsNotEmpty() @IsString() vehicleNumber: string;
  @ApiProperty({ example: '2022 Toyota Camry XSE' }) @IsNotEmpty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ example: 'Toyota' }) @IsNotEmpty() @IsString() company: string;
  @ApiProperty({ example: 'Camry' }) @IsNotEmpty() @IsString() model: string;
  @ApiProperty({ example: 2022, minimum: 1900, maximum: 2100 }) @IsInt() @Min(1900) @Max(2100) year: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber() @Min(0) kmDriven?: number;
  @ApiProperty({ example: 35000 }) @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) ownerCount?: number;
  @ApiPropertyOptional({ enum: FuelType }) @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @ApiPropertyOptional({ enum: Transmission }) @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional({ enum: HostingType }) @IsOptional() @IsEnum(HostingType) hosting?: HostingType;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() features?: string[];
}

export class UpdateVehicleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional({ enum: HostingType }) @IsOptional() @IsEnum(HostingType) hosting?: HostingType;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() features?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) kmDriven?: number;
}

export class VehicleQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() company?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPrice?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxPrice?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() minYear?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() maxYear?: number;
  @ApiPropertyOptional({ enum: FuelType }) @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @ApiPropertyOptional({ enum: Transmission }) @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
}
