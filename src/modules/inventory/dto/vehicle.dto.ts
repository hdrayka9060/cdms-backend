import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty, IsString, IsNumber, IsEnum, IsOptional, IsArray, Min, Max, IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleStatus, HostingType, FuelType, Transmission } from '../schemas/vehicle.schema';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class CreateVehicleDto {
  @ApiPropertyOptional({ description: 'Auto-generated as "V-XXXXX" if omitted' })
  @IsOptional() @IsString() vehicleNumber?: string;
  @ApiProperty({ example: '2022 Toyota Camry XSE' }) @IsNotEmpty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ example: 'Toyota' }) @IsNotEmpty() @IsString() company: string;
  @ApiProperty({ example: 'Camry' }) @IsNotEmpty() @IsString() model: string;
  @ApiProperty({ example: 2022, minimum: 1900, maximum: 2100 }) @IsInt() @Min(1900) @Max(2100) year: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber() @Min(0) km?: number;
  @ApiProperty({ example: 35000 }) @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional({ default: 0, description: 'Absolute discount in dollars (not a percent)' })
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) owners?: number;
  @ApiPropertyOptional({ enum: FuelType }) @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @ApiPropertyOptional({ enum: Transmission }) @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional({ description: 'Free-text body type (e.g. "Sedan", "SUV"). Populated by VIN decoder.' })
  @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional({ description: 'Trim / series (e.g. "XSE").' }) @IsOptional() @IsString() trim?: string;
  @ApiPropertyOptional({ description: 'Engine summary (e.g. "2.0L · 4-cyl").' }) @IsOptional() @IsString() engine?: string;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional({ enum: HostingType }) @IsOptional() @IsEnum(HostingType) hosting?: HostingType;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() features?: string[];
  @ApiPropertyOptional({ description: 'Optional SellerLead ObjectId. Omit/null = "Self" (in-house).' })
  @IsOptional() @IsString() seller?: string | null;
  @ApiPropertyOptional({ description: 'Cost-of-acquisition price.' })
  @IsOptional() @IsNumber() @Min(0) costPrice?: number;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() company?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1900) @Max(2100) year?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional({ description: 'Absolute discount in dollars (not a percent)' })
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
  @ApiPropertyOptional({ enum: HostingType }) @IsOptional() @IsEnum(HostingType) hosting?: HostingType;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() trim?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() engine?: string;
  @ApiPropertyOptional({ enum: FuelType }) @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @ApiPropertyOptional({ enum: Transmission }) @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() features?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) km?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) owners?: number;
  @ApiPropertyOptional({ description: 'SellerLead ObjectId, or null/empty to unlink ("Self").' })
  @IsOptional() @IsString() seller?: string | null;
  @ApiPropertyOptional({ description: 'Cost-of-acquisition price.' })
  @IsOptional() @IsNumber() @Min(0) costPrice?: number;
  @ApiPropertyOptional({ description: 'Actual sold price (set when vehicle is marked sold).' })
  @IsOptional() @IsNumber() @Min(0) soldAt?: number;
  @ApiPropertyOptional({ description: 'ISO date the vehicle was sold.' })
  @IsOptional() @IsString() soldDate?: string;
}

export class CreateVehicleSpendDto {
  @ApiProperty({ example: 500, description: 'Amount spent (dealership currency).' })
  @IsNumber() @Min(0) amount: number;
  @ApiPropertyOptional({
    description: 'Free-text category. Client offers: Repair | Service | Parts | Transport | Detailing | Other.',
    example: 'Repair',
  })
  @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional({ description: 'What the money was spent on.' })
  @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ description: 'ISO date of the spend. Defaults to now.' })
  @IsOptional() @IsString() date?: string;
}

export class UpdateVehicleSpendDto {
  @ApiPropertyOptional({ example: 450 }) @IsOptional() @IsNumber() @Min(0) amount?: number;
  @ApiPropertyOptional({ example: 'Service' }) @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ description: 'ISO date of the spend.' }) @IsOptional() @IsString() date?: string;
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
