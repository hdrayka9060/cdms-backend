import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmBuyersController } from './crm-buyers.controller';
import { CrmBuyersService } from './crm-buyers.service';
import { BuyerLead, BuyerLeadSchema } from './schemas/buyer-lead.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: BuyerLead.name, schema: BuyerLeadSchema }])],
  controllers: [CrmBuyersController],
  providers: [CrmBuyersService],
  exports: [CrmBuyersService],
})
export class CrmBuyersModule {}
