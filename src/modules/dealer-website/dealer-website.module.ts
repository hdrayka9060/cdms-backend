import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DealerWebsiteController } from './dealer-website.controller';
import { BuyerPortalService } from './buyer-portal.service';
import { WebsiteInquiryService } from './website-inquiry.service';
import { InventoryModule } from '../inventory/inventory.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { Sale, SaleSchema } from '../accounting/schemas/accounting.schema';
import { CalendarEvent, CalendarEventSchema } from '../calendar/schemas/calendar-event.schema';
import { DealerSettings, DealerSettingsSchema } from '../settings/schemas/dealer-settings.schema';

/**
 * Public, unauthenticated surface of the app. Hosts the dealer website
 * endpoints AND the Buyer Portal (GET /website/portal/:id).
 *
 * The portal aggregates data across several collections; their schemas are
 * re-registered here (schema-only, no module cycles — the project's standard
 * cross-module read pattern) so BuyerPortalService can read them directly.
 */
@Module({
  imports: [
    InventoryModule,
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: Vehicle.name, schema: VehicleSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      { name: DealerSettings.name, schema: DealerSettingsSchema },
    ]),
  ],
  controllers: [DealerWebsiteController],
  providers: [BuyerPortalService, WebsiteInquiryService],
})
export class DealerWebsiteModule {}
