import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ReceivablesController } from './receivables.controller';
import { ReceivablesService } from './receivables.service';
import { Sale, SaleSchema, Expense, ExpenseSchema, Income, IncomeSchema } from './schemas/accounting.schema';
import { Receivable, ReceivableSchema } from './schemas/receivable.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { BuyerLead, BuyerLeadSchema } from '../crm-buyers/schemas/buyer-lead.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Expense.name, schema: ExpenseSchema },
      // Income ledger — BHPH financing interest, recognized as collected.
      { name: Income.name, schema: IncomeSchema },
      // Receivables — open balances on partial/unpaid non-BHPH sales.
      { name: Receivable.name, schema: ReceivableSchema },
      // Direct vehicle write access — recording a sale auto-flips the
      // linked vehicle's status to "sold" so the two systems can't drift.
      { name: Vehicle.name, schema: VehicleSchema },
      // Optional post-effects: push to buyer.purchases when buyerLeadId is
      // supplied, close the lead when leadId is supplied. Schemas only —
      // we don't import CrmBuyersModule / LeadsModule to avoid cycles.
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      { name: Lead.name, schema: LeadSchema },
    ]),
  ],
  controllers: [AccountingController, ReceivablesController],
  providers: [AccountingService, ReceivablesService],
  exports: [AccountingService, ReceivablesService],
})
export class AccountingModule {}
