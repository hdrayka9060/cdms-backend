import { Global, Module } from '@nestjs/common';
import { GoogleMeetService } from './google-meet.service';

/**
 * Registered globally so CalendarService (and any future caller) can inject
 * GoogleMeetService without importing this module. Mirrors ActivityModule +
 * MailModule.
 */
@Global()
@Module({
  providers: [GoogleMeetService],
  exports: [GoogleMeetService],
})
export class GoogleMeetModule {}
