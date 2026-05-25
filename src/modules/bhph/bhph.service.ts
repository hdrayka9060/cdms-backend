import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Loan, LoanDocument, LoanStatus } from './schemas/loan.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class BhphService {
  constructor(@InjectModel(Loan.name) private model: Model<LoanDocument>) {}

  private calcEmi(principal: number, ratePercent: number, termMonths: number): number {
    if (ratePercent === 0) return principal / termMonths;
    const r = ratePercent / 100 / 12;
    return (principal * r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
  }

  private buildSchedule(loan: LoanDocument): any[] {
    const schedule = [];
    let balance = loan.principal;
    const r = loan.interestRatePercent / 100 / 12;
    const emi = loan.emiAmount;
    const start = new Date(loan.startDate);
    for (let i = 1; i <= loan.termMonths; i++) {
      const interest = balance * r;
      const principalPart = emi - interest;
      balance -= principalPart;
      const dueDate = new Date(start);
      dueDate.setMonth(dueDate.getMonth() + i);
      schedule.push({ installmentNo: i, dueDate, emiAmount: Math.round(emi * 100) / 100, principalPart: Math.round(principalPart * 100) / 100, interestPart: Math.round(interest * 100) / 100, balance: Math.max(0, Math.round(balance * 100) / 100) });
    }
    return schedule;
  }

  async create(dto: any): Promise<LoanDocument> {
    const emi = this.calcEmi(dto.principal, dto.interestRatePercent, dto.termMonths);
    const endDate = new Date(dto.startDate);
    endDate.setMonth(endDate.getMonth() + dto.termMonths);
    return new this.model({ ...dto, emiAmount: Math.round(emi * 100) / 100, endDate }).save();
  }

  async findAll(query: any): Promise<PaginatedResult<LoanDocument>> {
    const { page = 1, limit = 20, status, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (status) filter.status = status;
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('vehicle', 'title vehicleNumber').lean(), this.model.countDocuments(filter)]);
    return new PaginatedResult(data as unknown as LoanDocument[], total, page, limit);
  }

  async findById(id: string): Promise<{ loan: LoanDocument; schedule: any[] }> {
    const loan = await this.model.findOne({ _id: id, isDeleted: false }).populate('vehicle');
    if (!loan) throw new NotFoundException('Loan not found');
    return { loan, schedule: this.buildSchedule(loan) };
  }

  async recordPayment(id: string, dto: any): Promise<LoanDocument> {
    const loan = await this.model.findOne({ _id: id, isDeleted: false });
    if (!loan) throw new NotFoundException('Loan not found');
    const newTotalPaid = loan.totalPaid + dto.amount;
    const isPaidOff = newTotalPaid >= loan.principal;
    return this.model.findByIdAndUpdate(id, {
      $push: { payments: { ...dto, date: dto.date || new Date() } },
      $set: { totalPaid: newTotalPaid, status: isPaidOff ? LoanStatus.PAID_OFF : LoanStatus.ACTIVE },
    }, { new: true });
  }

  async getLoanSummary(): Promise<any> {
    return this.model.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: '$status', count: { $sum: 1 }, totalPrincipal: { $sum: '$principal' }, totalPaid: { $sum: '$totalPaid' } } }]);
  }
}
