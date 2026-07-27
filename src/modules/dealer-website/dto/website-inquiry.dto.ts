import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export enum InquiryFormType {
  FINANCING = 'financing',
  SERVICE = 'service',
  CAR_FINDER = 'car-finder',
  APPOINTMENT = 'appointment',
  CONTACT = 'contact',
  TEST_DRIVE = 'test-drive',
}

/**
 * Public website form submission. Captures the contact details plus a free-form
 * `details` bag of form-specific fields (serialized into the lead notes) and an
 * optional `vehicleId` when the inquiry is about a specific listing.
 */
export class WebsiteInquiryDto {
  @ApiProperty({ enum: InquiryFormType })
  @IsEnum(InquiryFormType)
  formType: InquiryFormType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  phone: string;

  @ApiPropertyOptional({ description: 'Vehicle ObjectId this inquiry is about (opens a lead for it).' })
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @ApiPropertyOptional({ type: Object, description: 'Extra form fields; serialized into the lead notes.' })
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}
