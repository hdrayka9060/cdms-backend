import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarMigrator } from './calendar.migrator';
import { CalendarEvent, CalendarEventSchema } from './schemas/calendar-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { SellerLead, SellerLeadSchema } from '../crm-sellers/schemas/seller-lead.schema';

@Module({
  // User schema re-registered (schema-only, no module cycle) so CalendarService
  // can resolve the assignee's email when inviting attendees to a Meet event.
  imports: [
    MongooseModule.forFeature([
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      { name: User.name, schema: UserSchema },
      // Lead schema re-registered (schema-only, no module cycle) so
      // CalendarService can push a timeline note onto a linked lead when an
      // event referencing it is created / updated / deleted.
      { name: Lead.name, schema: LeadSchema },
      // Buyer/Seller lead schemas re-registered (schema-only) so the
      // Calendar:view-gated /calendar/directory endpoint can list attendee
      // options without the caller needing CRM Buyers/Sellers permissions.
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: SellerLead.name, schema: SellerLeadSchema },
    ]),
  ],
  controllers: [CalendarController],
  // CalendarMigrator runs on OnApplicationBootstrap to rename legacy
  // `blocked` events to `other` and cast any string refs to ObjectId.
  providers: [CalendarService, CalendarMigrator],
  exports: [CalendarService],
})
export class CalendarModule {}
