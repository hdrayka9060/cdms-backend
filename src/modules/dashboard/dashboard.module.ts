import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { SellerLead, SellerLeadSchema } from '../crm-sellers/schemas/seller-lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { Sale, SaleSchema } from '../accounting/schemas/accounting.schema';
import { CalendarEvent, CalendarEventSchema } from '../calendar/schemas/calendar-event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      { name: SellerLead.name, schema: SellerLeadSchema },
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: CalendarEvent.name, schema: CalendarEventSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
