import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Sale, SaleDocument, Expense, ExpenseDocument } from './schemas/accounting.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class AccountingService {
  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Expense.name) private expenseModel: Model<ExpenseDocument>,
  ) {}

  async getSummary(startDate?: string, endDate?: string): Promise<any> {
    const dateFilter: any = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    const matchFilter: any = { isDeleted: false };
    if (Object.keys(dateFilter).length) matchFilter.saleDate = dateFilter;

    const [salesAgg, expensesAgg, outstanding] = await Promise.all([
      this.saleModel.aggregate([{ $match: matchFilter }, { $group: { _id: null, totalRevenue: { $sum: '$salePrice' }, totalCost: { $sum: '$costPrice' }, count: { $sum: 1 } } }]),
      this.expenseModel.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      this.saleModel.aggregate([{ $match: { isDeleted: false, paymentStatus: 'pending' } }, { $group: { _id: null, total: { $sum: '$salePrice' } } }]),
    ]);

    const revenue = salesAgg[0]?.totalRevenue || 0;
    const cost = salesAgg[0]?.totalCost || 0;
    const expenses = expensesAgg[0]?.total || 0;
    return { totalRevenue: revenue, totalCost: cost, totalExpenses: expenses, totalProfit: revenue - cost - expenses, totalSales: salesAgg[0]?.count || 0, outstanding: outstanding[0]?.total || 0 };
  }

  async getSales(query: any): Promise<PaginatedResult<SaleDocument>> {
    const { page = 1, limit = 20, search, sort = '-saleDate', paymentStatus } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (search) filter.$or = [{ vehicleTitle: { $regex: search, $options: 'i' } }, { buyerName: { $regex: search, $options: 'i' } }];
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([this.saleModel.find(filter).sort(sortObj).skip(skip).limit(limit).lean(), this.saleModel.countDocuments(filter)]);
    return new PaginatedResult(data as SaleDocument[], total, page, limit);
  }

  async createSale(dto: any): Promise<SaleDocument> { return new this.saleModel(dto).save(); }

  async getExpenses(query: any): Promise<PaginatedResult<ExpenseDocument>> {
    const { page = 1, limit = 20, category, sort = '-date' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (category) filter.category = category;
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([this.expenseModel.find(filter).sort(sortObj).skip(skip).limit(limit).lean(), this.expenseModel.countDocuments(filter)]);
    return new PaginatedResult(data as ExpenseDocument[], total, page, limit);
  }

  async createExpense(dto: any): Promise<ExpenseDocument> { return new this.expenseModel(dto).save(); }

  async getProfitLoss(startDate: string, endDate: string): Promise<any> {
    const dateFilter = { $gte: new Date(startDate), $lte: new Date(endDate) };
    const [sales, expenses] = await Promise.all([
      this.saleModel.aggregate([{ $match: { isDeleted: false, saleDate: dateFilter } }, { $group: { _id: { $month: '$saleDate' }, revenue: { $sum: '$salePrice' }, cost: { $sum: '$costPrice' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      this.expenseModel.aggregate([{ $match: { isDeleted: false, date: dateFilter } }, { $group: { _id: { $month: '$date' }, total: { $sum: '$amount' } } }, { $sort: { _id: 1 } }]),
    ]);
    return { sales, expenses, summary: await this.getSummary(startDate, endDate) };
  }
}
