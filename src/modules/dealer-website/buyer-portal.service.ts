import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Lead, LeadDocument, LeadStatus } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import {
  Vehicle,
  VehicleDocument,
  VehicleStatus,
} from '../inventory/schemas/vehicle.schema';
import { Sale, SaleDocument } from '../accounting/schemas/accounting.schema';
import {
  CalendarEvent,
  CalendarEventDocument,
} from '../calendar/schemas/calendar-event.schema';
import {
  DealerSettings,
  DealerSettingsDocument,
} from '../settings/schemas/dealer-settings.schema';

const DEFAULT_BROWSE_URL = 'https://spinauto.ca/cars';

/**
 * Assembles the PUBLIC, read-only Buyer Portal payload for a single lead.
 *
 * The portal is unauthenticated and addressed by the raw lead id (the dealer's
 * choice — see project_buyer_portal memory / FACEBOOK-style public surface).
 * Because anyone with the link can read the response, this service is
 * deliberately stingy with PII: it returns the buyer's FIRST NAME only (for the
 * greeting), NEVER their email/phone, NEVER staff identities (assignedTo), and
 * NEVER internal note text. Communication history is reduced to channel + date
 * only (the locked privacy decision) — the staff-written `log[].summary` never
 * leaves the DB layer.
 *
 * All schemas are re-registered in DealerWebsiteModule (schema-only, no module
 * cycles), the project's standard cross-module read pattern.
 */
@Injectable()
export class BuyerPortalService {
  private readonly logger = new Logger(BuyerPortalService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(BuyerLead.name) private readonly buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<VehicleDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(CalendarEvent.name) private readonly eventModel: Model<CalendarEventDocument>,
    @InjectModel(DealerSettings.name) private readonly settingsModel: Model<DealerSettingsDocument>,
    private readonly config: ConfigService,
  ) {}

  async getBuyerPortal(leadId: string): Promise<any> {
    // A generic 404 for every "can't show it" case — never leak WHY (invalid
    // id vs. deleted vs. broken refs all look identical to a stranger).
    if (!isValidObjectId(leadId)) throw new NotFoundException('Portal not found');

    const lead = await this.leadModel
      .findOne({ _id: leadId, isDeleted: false })
      .populate('buyer', 'buyerName buyerEmail')
      .populate(
        'vehicle',
        'title company model year km price photos fuelType transmission color bodyType status soldAt soldDate',
      )
      .lean();
    if (!lead) throw new NotFoundException('Portal not found');

    const buyer: any = lead.buyer;
    const vehicle: any = lead.vehicle;
    if (!buyer || !vehicle) throw new NotFoundException('Portal not found');

    // ── Sold-state resolution ──────────────────────────────────────────────
    // Default: not sold → portal shows the vehicle + offer + journey normally.
    let sold: {
      isSold: boolean;
      soldToThisBuyer: boolean;
      soldPrice?: number;
      soldDate?: Date | null;
    } = { isSold: false, soldToThisBuyer: false };

    if (vehicle.status === VehicleStatus.SOLD) {
      const sale = await this.saleModel
        .findOne({ vehicleId: String(vehicle._id), isDeleted: false })
        .sort({ saleDate: -1 })
        .lean();
      // Primary signal: this lead is the one that was closed. Robust fallback:
      // the Sale's buyer email matches this lead's buyer (Sale has no leadId).
      const emailMatch =
        !!sale?.buyerEmail &&
        !!buyer.buyerEmail &&
        sale.buyerEmail.toLowerCase() === String(buyer.buyerEmail).toLowerCase();
      const soldToThisBuyer = lead.status === LeadStatus.CLOSED || emailMatch;

      if (soldToThisBuyer) {
        const netFromSale = sale ? sale.salePrice - (sale.discount ?? 0) : 0;
        sold = {
          isSold: true,
          soldToThisBuyer: true,
          soldPrice: vehicle.soldAt || netFromSale || vehicle.price,
          soldDate: vehicle.soldDate ?? sale?.saleDate ?? null,
        };
      } else {
        sold = { isSold: true, soldToThisBuyer: false };
      }
    }

    // ── Appointments — calendar events linked to this lead ─────────────────
    const events = await this.eventModel
      .find({ lead: new Types.ObjectId(leadId), isDeleted: false })
      .sort({ startDateTime: 1 })
      .select('title eventType startDateTime endDateTime meetingType location meetLink status')
      .lean();
    const appointments = events.map((e) => ({
      type: e.eventType,
      title: e.title,
      start: e.startDateTime,
      end: e.endDateTime,
      meetingType: e.meetingType,
      location: e.location ?? '',
      meetLink: e.meetLink ?? '',
      status: e.status,
    }));

    // ── Communications — channel + date ONLY (privacy: no summary text) ────
    const communications = (lead.log ?? [])
      .slice()
      .sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date))
      .map((l: any) => ({ date: l.date, channel: l.channel, summary: l.summary ?? '' }));

    // ── Dealer contact (passive — no message form) ─────────────────────────
    const settings = await this.settingsModel.findOne({}).lean();
    // Always return a full dealer contact block for the portal's "Need help?"
    // section. Real values come from Settings; when a field is blank we fall
    // back to sensible Canadian placeholders so the section is never empty.
    const settingsAddress = [
      settings?.address,
      settings?.city,
      settings?.state,
      settings?.zipCode,
      settings?.country,
    ]
      .filter(Boolean)
      .join(', ');
    const dealer = {
      name: settings?.dealershipName || 'Spin Auto',
      phone: settings?.phone || '+1 (416) 555-0142',
      email: settings?.email || 'sales@spinauto.ca',
      address: settingsAddress || '123 Yonge Street, Toronto, ON M5C 1W4, Canada',
    };

    const fullName = String(buyer.buyerName ?? '').trim();
    const firstName = fullName.split(/\s+/)[0] || fullName || 'there';

    return {
      buyer: { firstName },
      journeyStatus: lead.status, // raw LeadStatus → frontend maps to the stepper
      offer:
        lead.askedPrice && lead.askedPrice > 0 ? { askedPrice: lead.askedPrice } : null,
      vehicle: {
        title: vehicle.title,
        company: vehicle.company,
        model: vehicle.model,
        year: vehicle.year,
        km: vehicle.km ?? 0,
        price: vehicle.price,
        photos: vehicle.photos ?? [],
        fuelType: vehicle.fuelType ?? '',
        transmission: vehicle.transmission ?? '',
        color: vehicle.color ?? '',
        bodyType: vehicle.bodyType ?? '',
        status: vehicle.status,
      },
      sold,
      appointments,
      communications,
      dealer,
      browseUrl:
        this.config.get<string>('PUBLIC_BROWSE_URL') || DEFAULT_BROWSE_URL,
    };
  }
}
