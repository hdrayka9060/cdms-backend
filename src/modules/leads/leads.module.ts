import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsMigrator } from './leads.migrator';
import { Lead, LeadSchema } from './schemas/lead.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { AccountingModule } from '../accounting/accounting.module';
import { CrmBuyersModule } from '../crm-buyers/crm-buyers.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      // Direct vehicle read access — used to hydrate communication log
      // entries' optional vehicle ref without relying on populate.
      { name: Vehicle.name, schema: VehicleSchema },
      // Direct BuyerLead write access — closing a lead pushes a purchase
      // entry onto the buyer's `purchases[]` array.
      { name: BuyerLead.name, schema: BuyerLeadSchema },
    ]),
    // forwardRef: AccountingModule imports Inventory's Vehicle schema and
    // Inventory's module is also imported by other modules — keep this lazy.
    forwardRef(() => AccountingModule),
    // Reused to create-or-dedup a CRM buyer when a new buyer is entered while
    // creating a lead / assigning a buyer to a walk-in. Plain (non-circular).
    CrmBuyersModule,
  ],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsMigrator],
  exports: [LeadsService],
})
export class LeadsModule {}
