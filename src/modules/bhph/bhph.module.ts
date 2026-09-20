import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BhphController } from './bhph.controller';
import { BhphService } from './bhph.service';
import { Loan, LoanSchema } from './schemas/loan.schema';
import { AccountingModule } from '../accounting/accounting.module';
import { CrmBuyersModule } from '../crm-buyers/crm-buyers.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Loan.name, schema: LoanSchema },
      // Schemas only (no owning modules) for read-side party resolution —
      // create-from-lead auto-fills buyer + vehicle, and buyer/vehicle titles.
      { name: Lead.name, schema: LeadSchema },
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: Vehicle.name, schema: VehicleSchema },
    ]),
    // One-way dependency: BHPH → Accounting (creates the linked Sale on loan
    // creation and keeps sale amountPaid + interest income in sync as EMIs land).
    // AccountingModule must never import BhphModule (would create a cycle).
    AccountingModule,
    // Inline buyer creation reuses the canonical dedupe-by-email CRM flow.
    CrmBuyersModule,
  ],
  controllers: [BhphController],
  providers: [BhphService],
  exports: [BhphService],
})
export class BhphModule {}
