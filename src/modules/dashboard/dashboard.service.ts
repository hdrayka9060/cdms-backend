import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Vehicle, VehicleDocument, VehicleStatus } from '../inventory/schemas/vehicle.schema';
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
  // Full-cost expenses (matches AccountingService.getSummary):
  //   totalExpenses = totalOperational + totalReconditioning + totalCostOfVehicles
  totalExpenses: number;
  totalOperational: number;
  totalReconditioning: number;
  totalCostOfVehicles: number;
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

    // Sales in the window — drives the period-scoped money KPIs (revenue /
    // expenses / profit). Money is a FLOW metric: the period selector applies.
    const soldFilter = { isDeleted: false, ...inRange('saleDate') };
    // Total Vehicles + Vehicles Sold are FLOW metrics — they follow the period
    // selector. Total Vehicles = vehicles ADDED in the window (createdAt);
    // Vehicles Sold = vehicles whose sale landed in the window (soldDate). We
    // count sold *vehicles* (status=sold) rather than Sale rows so the number
    // can't drift from the true sold-vehicle count. All-Time (no range) → all
    // non-deleted / all sold. Both current + previous blocks compute their own
    // window, so the trend-delta chip is meaningful here.
    const allVehiclesFilter = { isDeleted: false, ...inRange('createdAt') };
    const soldVehiclesFilter = {
      isDeleted: false,
      status: VehicleStatus.SOLD,
      ...inRange('soldDate'),
    };
    // Active Leads is a STOCK metric — the current open pipeline, not "leads
    // created this period" — so it ignores the window (matches the Leads page).
    const leadFilter = {
      isDeleted: false,
      status: { $nin: ['closed', 'archived'] },
    };
    // "Pending" = a test drive whose scheduled start time is still in the
    // future (startDateTime > now), excluding cancelled / no-show. A STATE
    // metric, deliberately window-independent so "This Month" doesn't hide an
    // upcoming drive scheduled for next month. Both current + previous blocks
    // compute the same number with the same `now`, so the delta chip is hidden.
    const testDriveFilter = {
      eventType: 'test_drive',
      isDeleted: false,
      status: { $nin: ['cancelled', 'no_show'] },
      startDateTime: { $gt: new Date() },
    };

    const [
      totalVehicles, vehiclesSold, salesAgg, operationalAgg, activeLeads, pendingTestDrives,
    ] = await Promise.all([
      // Stock counts — un-windowed so they match Inventory / Leads reality.
      this.vehicleModel.countDocuments(allVehiclesFilter),
      this.vehicleModel.countDocuments(soldVehiclesFilter),
      this.saleModel.aggregate([
        { $match: soldFilter },
        {
          $group: {
            _id: null,
            revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            // Cost of vehicles sold (recognised at sale). Reconditioning is NOT
            // taken from the sale here — it lives in the expense ledger now.
            cost: { $sum: { $ifNull: ['$costPrice', 0] } },
          },
        },
      ]),
      // Expenses in the window, split into operating vs reconditioning — matches
      // AccountingService.getSummary so the dashboard and accounting agree.
      this.expenseModel.aggregate([
        { $match: { isDeleted: false, ...inRange('date') } },
        {
          $group: {
            _id: null,
            operational: { $sum: { $cond: [{ $eq: ['$category', 'reconditioning'] }, 0, '$amount'] } },
            reconditioning: { $sum: { $cond: [{ $eq: ['$category', 'reconditioning'] }, '$amount', 0] } },
          },
        },
      ]),
      this.leadModel.countDocuments(leadFilter),
      this.calendarModel.countDocuments(testDriveFilter),
    ]);

    const revenue = salesAgg[0]?.revenue ?? 0;
    const cost = salesAgg[0]?.cost ?? 0;
    const operational = operationalAgg[0]?.operational ?? 0;
    const spend = operationalAgg[0]?.reconditioning ?? 0;
    // Full-cost expenses, identical to AccountingService.getSummary:
    //   Total Expenses = Operational + Reconditioning + Cost(of sold)
    //   Profit         = Revenue − Total Expenses
    // Reconditioning comes from the expense ledger (recognised when incurred);
    // cost of vehicles is recognised at sale. Each spend counted once.
    const totalExpenses = operational + spend + cost;
    return {
      totalVehicles,
      vehiclesSold,
      totalRevenue: revenue,
      totalExpenses,
      totalOperational: operational,
      totalReconditioning: spend,
      totalCostOfVehicles: cost,
      totalProfit: revenue - totalExpenses,
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
   * Three chart data sets, all over a fixed last-12-months window (the period
   * selector drives the KPIs; the trend charts are deliberately fixed so users
   * can see seasonality):
   *   - revenueAndProfit: monthly net revenue + full-cost net profit.
   *   - vehiclesByType: count by bodyType (free-text from the VIN decoder).
   *     Top 5 buckets + "Other" so the donut doesn't get cluttered.
   *   - monthlyExpenses: monthly Total Expenses — Operational + Reconditioning
   *     + Cost-of-vehicles-sold — matching the accounting page's definition
   *     (NOT operating expenses alone).
   */
  async getCharts(): Promise<{
    revenueAndProfit: { _id: { year: number; month: number }; revenue: number; profit: number }[];
    vehiclesByType: { _id: string; count: number }[];
    monthlyExpenses: { _id: { year: number; month: number }; total: number }[];
  }> {
    const now = new Date();
    const last12Months = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [salesByMonth, vehiclesByType, opByMonth] = await Promise.all([
      this.saleModel.aggregate([
        { $match: { isDeleted: false, saleDate: { $gte: last12Months } } },
        {
          $group: {
            _id: { year: { $year: '$saleDate' }, month: { $month: '$saleDate' } },
            revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            // Cost of vehicles sold that month (acquisition cost only).
            // Reconditioning is captured in the expense ledger (opByMonth) now.
            cost: { $sum: { $ifNull: ['$costPrice', 0] } },
          },
        },
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
      ]),
    ]);

    // Merge the sales (revenue + cost) and expense (operational + reconditioning)
    // series by month. Build over the UNION of months so a month with expenses
    // but no sales still shows its (negative) profit and its expense bar —
    // matching the accounting page rather than silently dropping to zero.
    const keyOf = (y: number, m: number) => `${y}-${m}`;
    const revMap = new Map<string, number>();
    const costMap = new Map<string, number>();
    const opMap = new Map<string, number>();
    for (const b of salesByMonth as any[]) {
      revMap.set(keyOf(b._id.year, b._id.month), b.revenue ?? 0);
      costMap.set(keyOf(b._id.year, b._id.month), b.cost ?? 0);
    }
    for (const e of opByMonth as any[]) {
      // opByMonth.total already includes reconditioning (it's an expense row now).
      opMap.set(keyOf(e._id.year, e._id.month), e.total ?? 0);
    }

    const allKeys = new Set<string>([...revMap.keys(), ...costMap.keys(), ...opMap.keys()]);
    const revenueAndProfit: { _id: { year: number; month: number }; revenue: number; profit: number }[] = [];
    const monthlyExpenses: { _id: { year: number; month: number }; total: number }[] = [];
    for (const key of allKeys) {
      const [year, month] = key.split('-').map(Number);
      const revenue = revMap.get(key) ?? 0;
      const cost = costMap.get(key) ?? 0;
      const op = opMap.get(key) ?? 0;
      // Net profit = Revenue − (cost of vehicles sold + all expenses). Full-cost,
      // matches the accounting page. `op` already includes reconditioning.
      revenueAndProfit.push({ _id: { year, month }, revenue, profit: revenue - cost - op });
      // Total Expenses = Operational + Reconditioning (both in `op`) + Cost-of-vehicles-sold.
      monthlyExpenses.push({ _id: { year, month }, total: op + cost });
    }
    const bySort = (a: any, b: any) => a._id.year - b._id.year || a._id.month - b._id.month;
    revenueAndProfit.sort(bySort);
    monthlyExpenses.sort(bySort);

    return { revenueAndProfit, vehiclesByType, monthlyExpenses };
  }
}
