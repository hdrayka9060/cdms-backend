import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BhphController } from './bhph.controller';
import { BhphService } from './bhph.service';
import { Loan, LoanSchema } from './schemas/loan.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Loan.name, schema: LoanSchema }])],
  controllers: [BhphController],
  providers: [BhphService],
  exports: [BhphService],
})
export class BhphModule {}
