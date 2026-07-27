import { Global, Module } from '@nestjs/common';
import { GoogleAdsApiService } from './google-ads-api.service';
import { MetaAdsApiService } from './meta-ads-api.service';

/**
 * Cross-cutting read-only ad-platform API wrappers (Google Ads + Meta Ads),
 * registered globally so the ads-analytics feature service can inject them
 * without importing this module. Mirrors FacebookApiModule / MailModule /
 * GoogleMeetModule / StorageModule.
 */
@Global()
@Module({
  providers: [GoogleAdsApiService, MetaAdsApiService],
  exports: [GoogleAdsApiService, MetaAdsApiService],
})
export class AdsApiModule {}
