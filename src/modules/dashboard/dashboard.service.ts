import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import { SellerLead, SellerLeadDocument } from '../crm-sellers/schemas/seller-lead.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { Sale, SaleDocument } from '../accounting/schemas/accounting.schema';
import { CalendarEvent, CalendarEventDocument } from '../calendar/schemas/calendar-event.schema';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectModel(SellerLead.name) private sellerModel: Model<SellerLeadDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(CalendarEvent.name) private calendarModel: Model<CalendarEventDocument>,
  ) {}

  async getStats(): Promise<any> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalVehicles, vehiclesSold, pendingTestDrives,
      totalLeads, monthlyRevenue, monthlyProfit,
      revenueAll
    ] = await Promise.all([
      this.vehicleModel.countDocuments({ isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'sold', isDeleted: false }),
      this.calendarModel.countDocuments({ eventType: 'test_drive', status: 'scheduled', isDeleted: false }),
      this.buyerModel.countDocuments({ isDeleted: false }),
      this.saleModel.aggregate([{ $match: { isDeleted: false, saleDate: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$salePrice' } } }]),
      this.saleModel.aggregate([{ $match: { isDeleted: false, saleDate: { $gte: startOfMonth } } }, { $group: { _id: null, profit: { $sum: { $subtract: ['$salePrice', '$costPrice'] } } } }]),
      this.saleModel.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: null, total: { $sum: '$salePrice' } } }]),
    ]);

    return {
      totalVehicles,
      vehiclesSold,
      pendingTestDrives,
      totalLeads,
      monthlyRevenue: monthlyRevenue[0]?.total || 0,
      monthlyProfit: monthlyProfit[0]?.profit || 0,
      totalRevenue: revenueAll[0]?.total || 0,
    };
  }

  async getCharts(): Promise<any> {
    const now = new Date();
    const last6Months = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [monthlySales, vehiclesByStatus, leadsByStage] = await Promise.all([
      this.saleModel.aggregate([
        { $match: { isDeleted: false, saleDate: { $gte: last6Months } } },
        { $group: { _id: { year: { $year: '$saleDate' }, month: { $month: '$saleDate' } }, revenue: { $sum: '$salePrice' }, count: { $sum: 1 } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      this.vehicleModel.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.buyerModel.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
      ]),
    ]);

    return { monthlySales, vehiclesByStatus, leadsByStage };
  }
}
