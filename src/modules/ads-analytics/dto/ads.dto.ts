import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { AdsProvider } from '../schemas/ads-connection.schema';

/** Body for `POST /marketing/ads/connect/start`. */
export class ConnectStartDto {
  @ApiProperty({ enum: AdsProvider, description: 'Which ad platform to connect' })
  @IsEnum(AdsProvider)
  provider: AdsProvider;
}

/**
 * Body for `POST /marketing/ads/connect/callback`. The frontend posts the OAuth
 * `code` (+ `state`) received on the provider redirect. In dev-mode both are
 * ignored — the wrapper mints mock tokens — so both are optional.
 */
export class ConnectCallbackDto {
  @ApiProperty({ enum: AdsProvider })
  @IsEnum(AdsProvider)
  provider: AdsProvider;

  @ApiPropertyOptional({ description: 'OAuth authorization code (real-mode only)' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: 'CSRF state echoed back from the redirect' })
  @IsOptional()
  @IsString()
  state?: string;
}

/** Bind / switch which ad account a connection reports on (no re-auth needed). */
export class UpdateAdsConnectionDto {
  @ApiPropertyOptional({ description: 'Google customer id (digits) or Meta act_<id>' })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accountName?: string;

  @ApiPropertyOptional({ description: 'Google Manager (MCC) id used as login-customer-id' })
  @IsOptional()
  @IsString()
  loginCustomerId?: string;
}

/** Body for `POST /marketing/ads/sync`. Omit `provider` to sync every connection. */
export class SyncAdsDto {
  @ApiPropertyOptional({ enum: AdsProvider })
  @IsOptional()
  @IsEnum(AdsProvider)
  provider?: AdsProvider;
}

/** Query for `GET /marketing/ads/analytics`. Defaults to the last 30 days. */
export class AdsAnalyticsQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (inclusive)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (inclusive)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: AdsProvider, description: 'Filter to one platform' })
  @IsOptional()
  @IsEnum(AdsProvider)
  provider?: AdsProvider;
}
