import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmBuyersController } from './crm-buyers.controller';
import { CrmBuyersService } from './crm-buyers.service';
import { BuyerLead, BuyerLeadSchema } from './schemas/buyer-lead.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BuyerLead.name, schema: BuyerLeadSchema },
      // Direct Vehicle read access — bypasses populate quirks so the buyer's
      // interestedVehicles[] always hydrates reliably via a simple $in query.
      { name: Vehicle.name, schema: VehicleSchema },
    ]),
  ],
  controllers: [CrmBuyersController],
  providers: [CrmBuyersService],
  exports: [CrmBuyersService],
})
export class CrmBuyersModule {}
