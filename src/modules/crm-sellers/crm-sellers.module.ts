import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmSellersController } from './crm-sellers.controller';
import { CrmSellersService } from './crm-sellers.service';
import { SellerLead, SellerLeadSchema } from './schemas/seller-lead.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: SellerLead.name, schema: SellerLeadSchema }])],
  controllers: [CrmSellersController],
  providers: [CrmSellersService],
  exports: [CrmSellersService],
})
export class CrmSellersModule {}
