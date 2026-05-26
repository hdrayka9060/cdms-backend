import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import { SellerLead, SellerLeadDocument } from '../crm-sellers/schemas/seller-lead.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { Sale, SaleDocument, Expense, ExpenseDocument } from '../accounting/schemas/accounting.schema';
import { CalendarEvent, CalendarEventDocument } from '../calendar/schemas/calendar-event.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';

/**
 * Six KPIs we report per period.  Same shape for current & previous so the
 * frontend can compute deltas uniformly.
 */
export interface DashboardStatBlock {
  totalVehicles: number;
  vehiclesSold: number;
  totalRevenue: number;
  totalProfit: number;
  activeLeads: number;
  pendingTestDrives: number;
}

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectModel(SellerLead.name) private sellerModel: Model<SellerLeadDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Expense.name) private expenseModel: Model<ExpenseDocument>,
    @InjectModel(CalendarEvent.name) private calendarModel: Model<CalendarEventDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
  ) {}

  /**
   * Compute the [start, end] window of the period IMMEDIATELY before
   * [start, end] — same length, no overlap. Used for trend deltas.
   * Returns null when either bound is missing (all-time has no "previous").
   */
  private previousWindow(
    start: Date | null,
    end: Date | null,
  ): { start: Date; end: Date } | null {
    if (!start || !end) return null;
    const lengthMs = end.getTime() - start.getTime();
    if (lengthMs < 0) return null;
    const prevEnd = new Date(start.getTime() - 1); // one ms before current start
    const prevStart = new Date(prevEnd.getTime() - lengthMs);
    return { start: prevStart, end: prevEnd };
  }

  /**
   * One block of KPIs for the given window. `start`/`end` null = unfiltered
   * (used for the "current" block when the user selected "All Time", and
   * never for the "previous" block — see previousWindow).
   */
  private async computeBlock(
    start: Date | null,
    end: Date | null,
  ): Promise<DashboardStatBlock> {
    // Range matcher for sale-like records (uses the record's own date field).
    const inRange = (field: string) => {
      if (!start && !end) return {};
      const r: any = {};
      if (start) r.$gte = start;
      if (end) r.$lte = end;
      return { [field]: r };
    };

    const vehicleFilter = { isDeleted: false, ...inRange('createdAt') };
    const soldFilter = { isDeleted: false, ...inRange('saleDate') };
    const leadFilter = {
      isDeleted: false,
      status: { $nin: ['closed', 'archived'] },
      ...inRange('createdAt'),
    };
    // "Pending" means scheduled AND still in the future — a STATE, not a
    // window-bound metric. We deliberately ignore the date-range filter so
    // a user looking at "This Month" doesn't see a count for May that's
    // already in the past. Both current + previous blocks compute the same
    // number with the same `now`, so the trend delta is 0 (chip hidden).
    const testDriveFilter = {
      eventType: 'test_drive',
      status: 'scheduled',
      isDeleted: false,
      startDateTime: { $gt: new Date() },
    };

    const [
      totalVehicles, vehiclesSold, revenueAndProfit, activeLeads, pendingTestDrives,
    ] = await Promise.all([
      this.vehicleModel.countDocuments(vehicleFilter),
      this.saleModel.countDocuments(soldFilter),
      this.saleModel.aggregate([
        { $match: soldFilter },
        {
          $group: {
            _id: null,
            revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            // Profit = revenue − cost (matches the accounting page's definition).
            profit: { $sum: { $subtract: [{ $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] }, { $ifNull: ['$costPrice', 0] }] } },
          },
        },
      ]),
      this.leadModel.countDocuments(leadFilter),
      this.calendarModel.countDocuments(testDriveFilter),
    ]);

    return {
      totalVehicles,
      vehiclesSold,
      totalRevenue: revenueAndProfit[0]?.revenue ?? 0,
      totalProfit: revenueAndProfit[0]?.profit ?? 0,
      activeLeads,
      pendingTestDrives,
    };
  }

  /**
   * KPI block + (when there's a defined range) an equal-length "previous"
   * block so the frontend can show trend deltas.  When `hasPrevious` is
   * false (i.e. all-time), the UI hides the delta chips.
   */
  async getStats(startDate?: string, endDate?: string): Promise<{
    current: DashboardStatBlock;
    previous: DashboardStatBlock | null;
    hasPrevious: boolean;
    range: { startDate: string | null; endDate: string | null };
  }> {
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    // Push the end-of-range to end-of-day so a "today" filter includes today
    // (saleDate timestamps land at any time during the day).
    if (end) end.setHours(23, 59, 59, 999);

    const current = await this.computeBlock(start, end);

    const prevWindow = this.previousWindow(start, end);
    const previous = prevWindow
      ? await this.computeBlock(prevWindow.start, prevWindow.end)
      : null;

    return {
      current,
      previous,
      hasPrevious: previous !== null,
      range: { startDate: startDate ?? null, endDate: endDate ?? null },
    };
  }

  /**
   * Three chart data sets:
   *   - revenueAndProfit: monthly aggregation over the last 12 months (always
   *     12 months — the period selector drives KPIs, the trend chart is
   *     deliberately fixed so users can see seasonality.
   *   - vehiclesByType: count by bodyType (free-text from the VIN decoder).
   *     Top 5 buckets + "Other" so the donut doesn't get cluttered.
   *   - monthlyExpenses: sum of Expense.amount per month, last 12 months.
   */
  async getCharts(): Promise<{
    revenueAndProfit: { _id: { year: number; month: number }; revenue: number; profit: number }[];
    vehiclesByType: { _id: string; count: number }[];
    monthlyExpenses: { _id: { year: number; month: number }; total: number }[];
  }> {
    const now = new Date();
    const last12Months = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [revenueAndProfit, vehiclesByType, monthlyExpenses] = await Promise.all([
      this.saleModel.aggregate([
        { $match: { isDeleted: false, saleDate: { $gte: last12Months } } },
        {
          $group: {
            _id: { year: { $year: '$saleDate' }, month: { $month: '$saleDate' } },
            revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            profit: { $sum: { $subtract: [{ $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] }, { $ifNull: ['$costPrice', 0] }] } },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      this.vehicleModel.aggregate([
        { $match: { isDeleted: false } },
        // Group by bodyType — fall back to "Unknown" for empty strings so the
        // donut always renders something instead of a phantom slice.
        {
          $group: {
            _id: { $cond: [{ $eq: [{ $ifNull: ['$bodyType', ''] }, ''] }, 'Unknown', '$bodyType'] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
      this.expenseModel.aggregate([
        { $match: { isDeleted: false, date: { $gte: last12Months } } },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            total: { $sum: '$amount' },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
    ]);

    return { revenueAndProfit, vehiclesByType, monthlyExpenses };
  }
}
