import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEmail, IsNumber, IsEnum, IsOptional, IsDateString, Min } from 'class-validator';
import { SellerLeadStage } from '../schemas/seller-lead.schema';

export class CreateSellerLeadDto {
  @ApiProperty() @IsNotEmpty() @IsString() sellerName: string;
  @ApiProperty() @IsEmail() sellerEmail: string;
  @ApiProperty() @IsNotEmpty() @IsString() sellerPhone: string;
  @ApiProperty() @IsNotEmpty() @IsString() vehicleTitle: string;
  @ApiProperty() @IsNotEmpty() @IsString() vehicleCompany: string;
  @ApiProperty() @IsNotEmpty() @IsString() vehicleModel: string;
  @ApiProperty() @IsNumber() vehicleYear: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) vehicleKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) askingPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateSellerLeadDto {
  @ApiPropertyOptional({ enum: SellerLeadStage }) @IsOptional() @IsEnum(SellerLeadStage) stage?: SellerLeadStage;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
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
}
