import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { AccountingService } from './accounting.service';
import { Sale, Expense } from './schemas/accounting.schema';
import { Vehicle } from '../inventory/schemas/vehicle.schema';
import { BuyerLead } from '../crm-buyers/schemas/buyer-lead.schema';
import { Lead, LeadStatus } from '../leads/schemas/lead.schema';
import { ActivityService } from '../activity/activity.service';

/**
 * Unit-tests the inverse of the unified sale flow.
 *
 * The behaviour these tests pin down:
 *   1. cleanupSoldArtifacts ARCHIVES the closed lead — it must not soft-delete
 *      it. The lead is the dealer's audit trail of "this car was once sold to
 *      that buyer, then the sale was reversed", and that trail must survive.
 *   2. The returned counts faithfully report what was mutated, so callers
 *      (and downstream UI / log lines) can verify the cascade fired.
 *   3. Soft-deleting the sale and pulling the buyer's purchases[] entry stays
 *      in the same operation — partial cleanups leave the system inconsistent.
 *
 * Mongoose models are mocked. We only assert the calls AccountingService
 * makes against them; nothing actually talks to Mongo.
 */
describe('AccountingService.cleanupSoldArtifacts', () => {
  let service: AccountingService;

  // Per-model mock containers. Each Model method we care about returns a
  // configurable promise; `.lean()` chains return the same promise. Each test
  // resets these to set up its scenario.
  const saleModel: any = {};
  const expenseModel: any = {};
  const vehicleModel: any = {};
  const buyerModel: any = {};
  const leadModel: any = {};

  beforeEach(async () => {
    // Default: no sales for this vehicle, no buyers to update, no leads to
    // archive. Individual tests override these per scenario.
    saleModel.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    saleModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    buyerModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    leadModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: getModelToken(Sale.name), useValue: saleModel },
        { provide: getModelToken(Expense.name), useValue: expenseModel },
        { provide: getModelToken(Vehicle.name), useValue: vehicleModel },
        { provide: getModelToken(BuyerLead.name), useValue: buyerModel },
        { provide: getModelToken(Lead.name), useValue: leadModel },
        // Stub ActivityService — these tests only care about cleanup behaviour,
        // not what activity entries got logged. `log()` returns void anyway.
        { provide: ActivityService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<AccountingService>(AccountingService);
  });

  it('returns all-zero counts when the vehicleId is invalid (defensive)', async () => {
    const counts = await service.cleanupSoldArtifacts('not-an-objectid');

    expect(counts).toEqual({ deletedSales: 0, pulledPurchases: 0, archivedLeads: 0 });
    // No collections should have been touched.
    expect(saleModel.find).not.toHaveBeenCalled();
    expect(saleModel.updateMany).not.toHaveBeenCalled();
    expect(leadModel.updateMany).not.toHaveBeenCalled();
    expect(buyerModel.updateMany).not.toHaveBeenCalled();
  });

  it('archives closed leads instead of soft-deleting them', async () => {
    const vehicleId = new Types.ObjectId().toHexString();
    leadModel.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const counts = await service.cleanupSoldArtifacts(vehicleId);

    // The most important assertion: the lead update sets status=ARCHIVED.
    // If anyone "optimizes" this back to isDeleted=true, the test fails loudly.
    expect(leadModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = leadModel.updateMany.mock.calls[0];

    expect(filter.status).toBe(LeadStatus.CLOSED);
    expect(filter.isDeleted).toBe(false);
    expect(String(filter.vehicle)).toBe(vehicleId);

    expect(update.$set).toEqual({ status: LeadStatus.ARCHIVED });
    expect(update.$set.isDeleted).toBeUndefined();
    expect(update.$push.timeline.action).toMatch(/sale was reverted/i);

    expect(counts.archivedLeads).toBe(1);
  });

  it('soft-deletes every non-deleted sale and pulls the buyer purchases entry', async () => {
    const vehicleId = new Types.ObjectId().toHexString();
    const saleObjId = new Types.ObjectId();

    saleModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: saleObjId }]),
      }),
    });
    saleModel.updateMany.mockResolvedValue({ modifiedCount: 1 });
    buyerModel.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const counts = await service.cleanupSoldArtifacts(vehicleId);

    // Sale gets soft-deleted (NOT hard-removed).
    expect(saleModel.updateMany).toHaveBeenCalledWith(
      { vehicleId, isDeleted: false },
      { $set: { isDeleted: true } },
    );

    // Buyer purchases[] entry gets pulled — by saleId, not by vehicle, so a
    // reverted sale doesn't accidentally clobber an unrelated purchase the
    // buyer made on the same car later.
    expect(buyerModel.updateMany).toHaveBeenCalledTimes(1);
    const [pullFilter, pullUpdate] = buyerModel.updateMany.mock.calls[0];
    expect(pullFilter['purchases.saleId'].$in).toContain(saleObjId);
    expect(pullUpdate.$pull.purchases.saleId.$in).toContain(saleObjId);

    expect(counts).toEqual({
      deletedSales: 1,
      pulledPurchases: 1,
      archivedLeads: 0,
    });
  });

  it('skips the buyer.purchases pull when no sales exist for this vehicle', async () => {
    const vehicleId = new Types.ObjectId().toHexString();
    // Default mock: saleModel.find returns []. Don't override.

    await service.cleanupSoldArtifacts(vehicleId);

    expect(buyerModel.updateMany).not.toHaveBeenCalled();
    // Sale soft-delete updateMany still runs (idempotent updateMany on empty
    // set is harmless and keeps the code path uniform).
    expect(saleModel.updateMany).toHaveBeenCalled();
    // Lead updateMany must still run — there could be a closed lead without
    // a Sale row (legacy data, partial creation failures, etc.).
    expect(leadModel.updateMany).toHaveBeenCalled();
  });

  it('reports faithful counts even when nothing matched', async () => {
    const vehicleId = new Types.ObjectId().toHexString();
    // All mocks return modifiedCount: 0 (default beforeEach setup).

    const counts = await service.cleanupSoldArtifacts(vehicleId);

    expect(counts).toEqual({ deletedSales: 0, pulledPurchases: 0, archivedLeads: 0 });
    // This is the diagnostic signal — counts of zero with a valid vehicleId
    // mean "the cascade ran but had no work to do" (or, in production:
    // "your data shape is wrong and the filter didn't match anything").
  });

  it('skips the lead archive step when options.archiveLeads is false', async () => {
    const vehicleId = new Types.ObjectId().toHexString();
    leadModel.updateMany.mockResolvedValue({ modifiedCount: 1 });
    saleModel.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const counts = await service.cleanupSoldArtifacts(vehicleId, { archiveLeads: false });

    // Sale still gets soft-deleted — the buyer's purchase still gets pulled.
    expect(saleModel.updateMany).toHaveBeenCalled();
    // Lead update must NOT have been called — that's the whole point of the
    // option. Without this, LeadsService.update's closed→other cascade would
    // overwrite the dealer's chosen status with ARCHIVED.
    expect(leadModel.updateMany).not.toHaveBeenCalled();
    expect(counts.archivedLeads).toBe(0);
  });
});
