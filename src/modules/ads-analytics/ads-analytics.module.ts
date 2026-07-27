import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdsAnalyticsController } from './ads-analytics.controller';
import { AdsAnalyticsService } from './ads-analytics.service';
import { AdsConnection, AdsConnectionSchema } from './schemas/ads-connection.schema';
import {
  AdsInsightSnapshot,
  AdsInsightSnapshotSchema,
} from './schemas/ads-insight-snapshot.schema';

/**
 * Read-only Google Ads + Meta Ads analytics for the Marketing tab. Injects the
 * @Global ads-api wrappers (GoogleAdsApiService / MetaAdsApiService) and the
 * @Global ActivityService — so this module only needs to register its own two
 * collections.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdsConnection.name, schema: AdsConnectionSchema },
      { name: AdsInsightSnapshot.name, schema: AdsInsightSnapshotSchema },
    ]),
  ],
  controllers: [AdsAnalyticsController],
  providers: [AdsAnalyticsService],
  exports: [AdsAnalyticsService],
})
export class AdsAnalyticsModule {}
