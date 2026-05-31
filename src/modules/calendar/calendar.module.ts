import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarMigrator } from './calendar.migrator';
import { CalendarEvent, CalendarEventSchema } from './schemas/calendar-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  // User schema re-registered (schema-only, no module cycle) so CalendarService
  // can resolve the assignee's email when inviting attendees to a Meet event.
  imports: [
    MongooseModule.forFeature([
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [CalendarController],
  // CalendarMigrator runs on OnApplicationBootstrap to rename legacy
  // `blocked` events to `other` and cast any string refs to ObjectId.
  providers: [CalendarService, CalendarMigrator],
  exports: [CalendarService],
})
export class CalendarModule {}
