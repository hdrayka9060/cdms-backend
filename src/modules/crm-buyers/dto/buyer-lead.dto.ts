import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray, IsDateString, IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min,
} from 'class-validator';
import { BuyerLeadStage } from '../schemas/buyer-lead.schema';

export class CreateBuyerLeadDto {
  @ApiProperty() @IsNotEmpty() @IsString() buyerName: string;
  @ApiProperty() @IsEmail() buyerEmail: string;
  @ApiProperty() @IsNotEmpty() @IsString() buyerPhone: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ type: [String], description: 'Vehicle ObjectIds the buyer is interested in.' })
  @IsOptional() @IsArray() @IsString({ each: true }) interestedVehicles?: string[];
  /** Backward compat — singular field. If both are sent, both are merged. */
  @ApiPropertyOptional() @IsOptional() @IsString() interestedVehicle?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) budget?: number;
  @ApiPropertyOptional({ enum: BuyerLeadStage }) @IsOptional() @IsEnum(BuyerLeadStage) stage?: BuyerLeadStage;
}

export class UpdateBuyerLeadDto {
  @ApiPropertyOptional() @IsOptional() @IsString() buyerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() buyerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() buyerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: BuyerLeadStage }) @IsOptional() @IsEnum(BuyerLeadStage) stage?: BuyerLeadStage;
  @ApiPropertyOptional() @IsOptional() @IsString() assignedTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) budget?: number;
}

export class AddInterestedVehicleDto {
  @ApiProperty() @IsNotEmpty() @IsString() vehicleId: string;
}

export class BookTestDriveDto {
  @ApiProperty() @IsNotEmpty() @IsString() vehicleId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleTitle?: string;
  @ApiPropertyOptional({ description: 'ISO date-time for the test drive.' })
  @IsOptional() @IsDateString() scheduledAt?: string;
  @ApiPropertyOptional({ description: 'Staff member (User ObjectId) responsible for the test drive.' })
  @IsOptional() @IsString() assignedTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// `offline` covers face-to-face / in-person / walk-in interactions that
// don't have a digital channel — kept as a flat enum value so the picker
// stays a single dropdown.
const COMM_CHANNELS = ['email', 'sms', 'whatsapp', 'call', 'offline'] as const;
export type BuyerCommChannel = (typeof COMM_CHANNELS)[number];

export class BuyerCommunicationDto {
  @ApiProperty({ enum: COMM_CHANNELS }) @IsEnum(COMM_CHANNELS) channel: BuyerCommChannel;
  @ApiPropertyOptional({ description: 'Vehicle ObjectId this interaction was about.' })
  @IsOptional() @IsString() vehicleId?: string;
  @ApiProperty() @IsNotEmpty() @IsString() summary: string;
  @ApiPropertyOptional({ description: 'ISO timestamp; defaults to now if omitted.' })
  @IsOptional() @IsDateString() at?: string;
  @ApiPropertyOptional({ description: 'User ObjectId of the staff member who performed this communication.' })
  @IsOptional() @IsString() byStaffId?: string;
}
