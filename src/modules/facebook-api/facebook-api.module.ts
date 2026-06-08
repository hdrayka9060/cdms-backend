import { Global, Module } from '@nestjs/common';
import { FacebookApiService } from './facebook-api.service';

/**
 * Cross-cutting Facebook Graph API wrapper, registered globally so any
 * Facebook-related feature service (connections now; publishing, insights and
 * webhook ingest in later phases) can inject FacebookApiService without
 * importing this module. Mirrors MailModule / GoogleMeetModule.
 */
@Global()
@Module({
  providers: [FacebookApiService],
  exports: [FacebookApiService],
})
export class FacebookApiModule {}
