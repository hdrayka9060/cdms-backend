import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { VinDecodeService } from './vin-decode.service';
import { Vehicle, VehicleSchema } from './schemas/vehicle.schema';
import { SellerLead, SellerLeadSchema } from '../crm-sellers/schemas/seller-lead.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { CalendarEvent, CalendarEventSchema } from '../calendar/schemas/calendar-event.schema';
import { CommunicationLog, CommunicationLogSchema } from '../communication/schemas/communication-log.schema';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      // Needed by InventoryService to keep seller.vehicles[] in sync when a
      // vehicle is soft-deleted. Importing only the schema (not CrmSellersModule)
      // avoids a circular module dependency.
      { name: SellerLead.name, schema: SellerLeadSchema },
      // Read-only, schema-only registrations for the per-vehicle Activity tab
      // (getVehicleActivity aggregates inquiries, test drives and the merged
      // communication log across these collections). Same cross-module read
      // pattern used by dealer-website / calendar — no module import, no cycle.
      { name: Lead.name, schema: LeadSchema },
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      { name: CommunicationLog.name, schema: CommunicationLogSchema },
    ]),
    // forwardRef: AccountingModule itself imports the Vehicle schema, so this
    // would otherwise deadlock at module-resolution time.
    forwardRef(() => AccountingModule),
    MulterModule.register({ dest: './uploads/vehicles' }),
  ],
  controllers: [InventoryController],
  providers: [InventoryService, VinDecodeService],
  exports: [InventoryService],
})
export class InventoryModule {}
