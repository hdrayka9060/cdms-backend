import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { BuyerLead, BuyerLeadDocument, BuyerLeadStage } from '../crm-buyers/schemas/buyer-lead.schema';
import { Lead, LeadChannel, LeadDocument, LeadSource, LeadStatus } from '../leads/schemas/lead.schema';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import { MailService } from '../mail/mail.service';
import { InquiryFormType, WebsiteInquiryDto } from './dto/website-inquiry.dto';

const FORM_LABEL: Record<InquiryFormType, string> = {
  [InquiryFormType.FINANCING]: 'Financing Application',
  [InquiryFormType.SERVICE]: 'Service Appointment',
  [InquiryFormType.CAR_FINDER]: 'Car Finder Request',
  [InquiryFormType.APPOINTMENT]: 'Appointment Request',
  [InquiryFormType.CONTACT]: 'Contact Enquiry',
  [InquiryFormType.TEST_DRIVE]: 'Test Drive Request',
};

/**
 * Handles public website form submissions. Self-contained: writes the
 * BuyerLead / Lead / Vehicle models directly (all registered in
 * DealerWebsiteModule) instead of importing the CRM/Leads modules, avoiding
 * their auth-bound dependency graphs. Every submission:
 *   1. upserts a CRM BuyerLead by email (no duplicate contacts on repeat forms), and
 *   2. opens a `source: website` Lead when a valid, available vehicle is referenced.
 */
@Injectable()
export class WebsiteInquiryService {
  private readonly logger = new Logger(WebsiteInquiryService.name);

  constructor(
    @InjectModel(BuyerLead.name) private readonly buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<VehicleDocument>,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Compose a human-readable notes blob from the form type, message and extra
   * fields. Pass `includeMessage: false` for the Contact Us / Text Us Now
   * forms, whose message is logged on the communication timeline instead.
   */
  private buildNotes(dto: WebsiteInquiryDto, opts?: { includeMessage?: boolean }): string {
    const includeMessage = opts?.includeMessage ?? true;
    const lines: string[] = [`[${FORM_LABEL[dto.formType]}] — submitted via website`];
    if (includeMessage && dto.message) lines.push('', dto.message.trim());
    if (dto.details && typeof dto.details === 'object') {
      const entries = Object.entries(dto.details).filter(
        ([, v]) => v !== undefined && v !== null && String(v).trim() !== '',
      );
      if (entries.length) {
        lines.push('');
        for (const [k, v] of entries) {
          const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
          lines.push(`${label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
        }
      }
    }
    return lines.join('\n').slice(0, 4000);
  }

  async submit(dto: WebsiteInquiryDto): Promise<{ received: true; buyerId: string; leadCreated: boolean }> {
    const name = dto.name.trim();
    const email = dto.email.trim().toLowerCase();
    const phone = dto.phone.trim();

    // The Contact Us / Text Us Now forms carry a free-text message. When one is
    // present we log it as a `website` communication entry — on BOTH the buyer's
    // timeline and the lead's log — in a single, shared line format, and keep it
    // OUT of the notes blob (the lead gets no notes at all in that case).
    const isContactForm = dto.formType === InquiryFormType.CONTACT;
    const message = (dto.message ?? '').trim();
    const logMessageInComm = isContactForm && message !== '';

    const vehicleOfInterest =
      dto.details && typeof dto.details === 'object'
        ? String((dto.details as Record<string, unknown>).vehicleOfInterest ?? '').trim()
        : '';

    // The car the enquiry is about is captured structurally (the comm log's
    // "vehicle" reference) rather than in the summary text, so the CRM shows it
    // in the car selector. Only a real vehicle ObjectId is attached.
    const vehicleRef =
      dto.vehicleId && isValidObjectId(dto.vehicleId) ? new Types.ObjectId(dto.vehicleId) : null;

    const notes = this.buildNotes(dto, { includeMessage: !logMessageInComm });

    // Shared communication summary used verbatim for both the buyer's
    // communication log and the lead's communication log:
    //   [Contact Enquiry] — <message>
    const enquirySummary = `[${FORM_LABEL[dto.formType]}] — ${message}`;

    const now = new Date();
    const communication: Record<string, unknown> = {
      _id: new Types.ObjectId(),
      at: now,
      channel: 'website',
      summary: logMessageInComm ? enquirySummary : notes,
    };
    if (logMessageInComm && vehicleRef) {
      communication.vehicle = vehicleRef;
      if (vehicleOfInterest) communication.vehicleTitle = vehicleOfInterest;
    }

    // 1. Upsert the CRM buyer by email so repeat submissions don't duplicate the contact.
    let buyer = await this.buyerModel.findOne({ buyerEmail: email, isDeleted: false });
    if (!buyer) {
      buyer = await new this.buyerModel({
        buyerName: name,
        buyerEmail: email,
        buyerPhone: phone,
        notes,
        stage: BuyerLeadStage.NEW,
        communications: [communication],
      }).save();
    } else {
      await this.buyerModel.updateOne(
        { _id: buyer._id },
        {
          $set: { buyerName: name || buyer.buyerName, buyerPhone: phone || buyer.buyerPhone },
          $push: { communications: communication },
        },
      );
    }

    // 2. Open a website lead when a valid vehicle is referenced.
    //    - Available (not sold) vehicle → NEW lead into the active pipeline.
    //    - Sold vehicle → normally no lead, EXCEPT for the Contact Us / Text Us
    //      Now forms: those still capture the interest as an ARCHIVED lead so
    //      the enquiry lives in the CRM without cluttering the active pipeline
    //      (staff can revive it if a similar car comes in).
    let leadCreated = false;
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      const vehicle = await this.vehicleModel.findOne({ _id: dto.vehicleId, isDeleted: false }).select('status');
      if (vehicle) {
        const isSold = vehicle.status === 'sold';
        // Contact Us / Text Us Now AND the Finance Application capture the lead
        // even when the car is already sold (as an archived lead) so no enquiry
        // is lost; other forms skip lead creation for a sold vehicle.
        const capturesLeadWhenSold =
          isContactForm || dto.formType === InquiryFormType.FINANCING;
        const shouldCreateLead = !isSold || capturesLeadWhenSold;
        if (shouldCreateLead) {
          const status = isSold ? LeadStatus.ARCHIVED : LeadStatus.NEW;
          const vehObj = new Types.ObjectId(dto.vehicleId);
          const action = isSold
            ? `Lead created from website (${FORM_LABEL[dto.formType]}) — archived: vehicle already sold`
            : `Lead created from website (${FORM_LABEL[dto.formType]})`;
          try {
            await new this.leadModel({
              buyer: new Types.ObjectId(String(buyer._id)),
              vehicle: vehObj,
              source: LeadSource.WEBSITE,
              status,
              // When a message was submitted it lives in the lead's communication
              // log below — not in notes, per the enquiry-logging contract.
              notes: logMessageInComm ? '' : notes,
              timeline: [{ date: now, action, by: 'website' }],
              log: logMessageInComm
                ? [
                    {
                      _id: new Types.ObjectId(),
                      date: now,
                      channel: LeadChannel.WEBSITE,
                      summary: enquirySummary,
                      vehicle: vehObj,
                      vehicleTitle: vehicleOfInterest || undefined,
                    },
                  ]
                : [],
            }).save();
            leadCreated = true;
            await this.buyerModel.updateOne(
              { _id: buyer._id },
              { $addToSet: { interestedVehicles: vehObj } },
            );
          } catch (err: any) {
            // Duplicate {buyer, vehicle} lead (compound unique index) → already inquired; ignore.
            if (err?.code !== 11000) {
              this.logger.error(`website inquiry lead create failed: ${err?.message ?? err}`);
            }
          }
        }
      }
    }

    // 3. Notify the dealership by email for EVERY form submission (best-effort —
    //    a mail failure must never fail the visitor's submission). The Finance
    //    Application carries far more detail and uses its own richer template;
    //    every other form (service, contact, text-us-now, get-more-info,
    //    car-finder, appointment, …) funnels through the generic notification.
    const recipient = (
      this.config.get<string>('WEBSITE_INQUIRY_EMAIL') ||
      this.config.get<string>('MAIL_USER') ||
      ''
    ).trim();
    if (recipient) {
      const fields =
        dto.details && typeof dto.details === 'object'
          ? (dto.details as Record<string, unknown>)
          : {};
      try {
        if (dto.formType === InquiryFormType.FINANCING) {
          await this.mailService.sendFinanceApplication({
            to: recipient,
            applicantName: name,
            applicantEmail: email,
            applicantPhone: phone,
            vehicleOfInterest: vehicleOfInterest || undefined,
            fields,
          });
        } else {
          await this.mailService.sendWebsiteInquiry({
            to: recipient,
            formLabel: FORM_LABEL[dto.formType],
            name,
            email,
            phone,
            vehicleOfInterest: vehicleOfInterest || undefined,
            message: message || undefined,
            fields,
          });
        }
      } catch (err: any) {
        this.logger.error(`website inquiry email failed (${dto.formType}): ${err?.message ?? err}`);
      }
    } else {
      this.logger.warn(
        `website inquiry email skipped (${dto.formType}) — no WEBSITE_INQUIRY_EMAIL/MAIL_USER configured`,
      );
    }

    this.logger.log(
      `website inquiry (${dto.formType}) from ${email} — buyer=${String(buyer._id)} leadCreated=${leadCreated}`,
    );
    return { received: true, buyerId: String(buyer._id), leadCreated };
  }
}
