import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { SellerLead, SellerLeadSchema } from '../crm-sellers/schemas/seller-lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { Sale, SaleSchema, Expense, ExpenseSchema } from '../accounting/schemas/accounting.schema';
import { CalendarEvent, CalendarEventSchema } from '../calendar/schemas/calendar-event.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      { name: SellerLead.name, schema: SellerLeadSchema },
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: Sale.name, schema: SaleSchema },
      // Expenses drive the Monthly Expenses bar chart; Leads drive the
      // Active Leads KPI when filtered by date range.
      { name: Expense.name, schema: ExpenseSchema },
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      { name: Lead.name, schema: LeadSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
