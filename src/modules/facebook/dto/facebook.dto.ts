import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { FacebookLeadStatus } from '../schemas/facebook-conversation.schema';
import { FacebookDestinationType } from '../schemas/facebook-listing.schema';

/**
 * Body for `POST /facebook/connect/callback`. In real-mode the frontend posts
 * the OAuth `code` (+ `state`) it received on the Facebook redirect. In
 * dev-mode both are ignored — the service mints a mock Page — so both are
 * optional.
 */
export class CompleteConnectDto {
  @ApiPropertyOptional({
    description: 'OAuth authorization code from Facebook (real-mode only; ignored in dev-mode).',
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: 'CSRF state echoed back from the OAuth redirect.' })
  @IsOptional()
  @IsString()
  state?: string;
}

/**
 * Set/clear a connection's Marketplace product-catalog id. The catalog enables
 * the Marketplace (catalog) destination + the Item API sync for that Page. The
 * id comes from Meta Commerce Manager (not auto-discoverable without extra
 * scopes), so the dealer pastes it in on the Destinations tab.
 */
export class UpdateConnectionDto {
  @ApiPropertyOptional({
    description:
      'Meta product-catalog id (Commerce Manager) for Marketplace catalog sync. Empty string clears it.',
  })
  @IsOptional()
  @IsString()
  catalogId?: string;

  @ApiPropertyOptional({
    description:
      'A System User access token with catalog_management — used for catalog writes (a Page token cannot, Graph code 100/33). Omit to leave unchanged; empty string clears it. Stored AES-encrypted.',
  })
  @IsOptional()
  @IsString()
  catalogToken?: string;
}

/**
 * Create one or more Page listings. The frontend builds the content from a
 * selected inventory vehicle. Selecting multiple `connectionIds` fans out to
 * one listing row per Page.
 */
export class CreateListingDto {
  @ApiProperty({ description: 'Source vehicle ObjectId' })
  @IsMongoId()
  vehicleId: string;

  @ApiPropertyOptional({ description: 'Vehicle title snapshot (for display/filtering)' })
  @IsOptional()
  @IsString()
  vehicleTitle?: string;

  @ApiProperty({ description: 'Listing title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ type: [String], description: 'Image URLs / stored paths' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contact?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Target connected-Page ids — one listing row created per id (page/marketplace)',
  })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  connectionIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Target group-target ids — creates assisted-manual draft listings (no auto-post)',
  })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  groupTargetIds?: string[];

  @ApiPropertyOptional({
    enum: FacebookDestinationType,
    description: 'page (default — organic Page post) or marketplace_catalog (catalog sync)',
  })
  @IsOptional()
  @IsEnum(FacebookDestinationType)
  destinationType?: FacebookDestinationType;

  @ApiPropertyOptional({ description: 'Publish immediately; otherwise saved as draft', default: true })
  @IsOptional()
  @IsBoolean()
  publishNow?: boolean;

  @ApiPropertyOptional({
    description: 'ISO datetime to schedule publishing for later (a future value overrides publishNow)',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

/** Save a reusable listing template. */
export class CreateTemplateDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Title with {{var}} placeholders' })
  @IsOptional()
  @IsString()
  titleTemplate?: string;

  @ApiPropertyOptional({ description: 'Description with {{var}} placeholders' })
  @IsOptional()
  @IsString()
  descriptionTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultLocation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultContact?: string;
}

/** Edit an existing listing's content / reschedule it. */
export class UpdateListingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contact?: string;

  @ApiPropertyOptional({ description: 'Reschedule (ISO datetime)' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

/** Reply to a comment received on a Page post. */
export class ReplyCommentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message: string;
}

/** Send a Messenger reply in a conversation. */
export class SendMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message: string;
}

/** Update a conversation's assignee and/or lead-pipeline status. */
export class UpdateConversationDto {
  @ApiPropertyOptional({ description: 'Assignee User id (empty string to unassign)' })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Assignee display-name snapshot' })
  @IsOptional()
  @IsString()
  assignedToName?: string;

  @ApiPropertyOptional({ enum: FacebookLeadStatus })
  @IsOptional()
  @IsEnum(FacebookLeadStatus)
  leadStatus?: FacebookLeadStatus;
}

/**
 * Promote a Messenger conversation into a real CDMS Lead. Creates a BuyerLead
 * (CRM) + a Lead (buyer × vehicle) — so the dealer must supply contact details
 * (a Messenger participant only reliably gives us a name).
 */
export class PromoteLeadDto {
  @ApiProperty({ description: 'Vehicle ObjectId the lead is about' })
  @IsMongoId()
  vehicleId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  buyerName: string;

  @ApiProperty()
  @IsEmail()
  buyerEmail: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  buyerPhone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

/** Register a Facebook Group as a posting target (registry only — Groups can't
 *  be auto-posted via API; this powers the assisted-manual paste flow). */
export class CreateGroupTargetDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'URL of the Facebook group' })
  @IsString()
  @IsNotEmpty()
  groupUrl: string;

  @ApiPropertyOptional({ description: 'Free-text category (e.g. Local Car Sales, Luxury, SUVs)' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

/** Mark a (group-manual) listing as posted after pasting it into the group. */
export class MarkPostedDto {
  @ApiPropertyOptional({ description: 'URL of the post you pasted into the group' })
  @IsOptional()
  @IsString()
  permalink?: string;
}
