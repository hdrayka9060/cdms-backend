import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  CalendarEvent,
  CalendarEventDocument,
  EventType,
  MeetingType,
  ParticipantStatus,
} from './schemas/calendar-event.schema';
import {
  CreateCalendarEventDto,
  ParticipantInputDto,
  UpdateCalendarEventDto,
} from './dto/calendar-event.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { ActivityService } from '../activity/activity.service';
import { GoogleMeetService } from '../google-meet/google-meet.service';
import { MailService } from '../mail/mail.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { SellerLead, SellerLeadDocument } from '../crm-sellers/schemas/seller-lead.schema';

/** Identity of the caller, threaded from the controller for authorization. */
export interface CalendarActor {
  id?: string;
  /** True when the caller's role grants full access (edit/delete any event). */
  isAdmin?: boolean;
}

/** Message shown when a requested Google Meet link could not be provisioned. */
const MEET_UNAVAILABLE_MSG =
  'Could not create a Google Meet link. Ensure Google Calendar is configured on the server, or uncheck "Create Google Meet link" and paste an existing link instead.';

/**
 * Calendar service.
 *
 * Major contract changes (vs. the previous version):
 *   1. `blockSlot` is gone — block-slot semantics are now a regular event
 *      with `eventType: 'other'`. The controller's `/block` endpoint was
 *      removed too. Existing data was renamed by `CalendarMigrator`.
 *   2. Events have a `participants[]` array supporting Staff / Buyer /
 *      Seller. Add + remove are exposed as discrete endpoints so the UI
 *      can manage attendees without a full event PATCH.
 *   3. `findAll` accepts `userId` to filter by attendees — i.e. show the
 *      events relevant to a specific staff member, buyer, or seller
 *      ("view another user's calendar" requirement). Matches against
 *      `assignedTo` OR any `participants[].userId`.
 *   4. Google Meet link is generated when `meetingType === 'virtual'` AND
 *      `createMeetLink: true`. We keep the previous mock-link approach
 *      (Math.random) but make the trigger explicit — physical meetings
 *      no longer get an unwanted Meet link.
 *   5. Every mutation writes an activity log row (existing pattern).
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @InjectModel(CalendarEvent.name) private model: Model<CalendarEventDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(SellerLead.name) private sellerModel: Model<SellerLeadDocument>,
    private readonly activity: ActivityService,
    private readonly googleMeet: GoogleMeetService,
    private readonly mail: MailService,
  ) {}

  /**
   * Whether `actor` may edit/delete `event`: the creator, the assigned staff
   * member, or a full-access (admin) user. Everyone else is blocked even if
   * their role grants Calendar:edit/delete (a participant with an edit-capable
   * role must NOT be able to mutate an event they neither created nor own).
   */
  private canManageEvent(
    event: Pick<CalendarEvent, 'createdBy' | 'assignedTo'>,
    actor?: CalendarActor,
  ): boolean {
    if (actor?.isAdmin) return true;
    if (!actor?.id) return false;
    const creator = event.createdBy ? String(event.createdBy) : '';
    const assignee = event.assignedTo ? String(event.assignedTo) : '';
    return actor.id === creator || actor.id === assignee;
  }

  /** Human-readable "when" line for invitation / update emails. */
  private whenText(d: Date | string): string {
    return new Date(d).toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Collect the email addresses to invite to a Meet event (the dealer chose
   * "invite everyone"): the assigned staff member (looked up by id), the
   * customer, and every participant with an email. Deduped; empties dropped.
   */
  private async assembleAttendees(opts: {
    assignedTo?: string;
    customerEmail?: string;
    participants?: { email?: string }[];
  }): Promise<string[]> {
    const emails = new Set<string>();
    if (opts.customerEmail) emails.add(opts.customerEmail);
    for (const p of opts.participants ?? []) {
      if (p?.email) emails.add(p.email);
    }
    if (opts.assignedTo) {
      try {
        const u = await this.userModel
          .findById(opts.assignedTo)
          .select('email')
          .lean();
        if (u?.email) emails.add(u.email);
      } catch {
        // Non-fatal — a missing assignee just means one fewer invitee.
      }
    }
    return [...emails].filter(Boolean);
  }

  /**
   * Email an INVITATION to an explicit recipient list — used both on create
   * (everyone) and on update (only the newly-added participants / new assignee).
   * Physical events carry the location; virtual events carry the link (or
   * "link to follow"). Best-effort: a mail failure must never break the event.
   */
  private async emailEventInvitation(
    recipients: string[],
    ctx: {
      title: string;
      start: Date | string;
      meetingType: MeetingType;
      location?: string;
      meetLink?: string;
    },
  ): Promise<void> {
    if (!recipients.length) return;
    try {
      await this.mail.sendEventInvitation({
        to: recipients,
        eventTitle: ctx.title,
        whenText: this.whenText(ctx.start),
        meetingType: ctx.meetingType === MeetingType.VIRTUAL ? 'virtual' : 'physical',
        location: ctx.location,
        meetLink: ctx.meetLink,
      });
    } catch (err) {
      this.logger.warn(`failed to email event invitation: ${err}`);
    }
  }

  /**
   * Email a single UPDATE notification to an explicit recipient list when an
   * event's timing changed and/or it was converted between physical and
   * virtual. The caller collapses every change into one `changesText` so
   * attendees get exactly one email per edit. Best-effort — never breaks it.
   */
  private async emailEventUpdate(
    recipients: string[],
    ctx: {
      title: string;
      start: Date | string;
      changesText: string;
      meetingType: MeetingType;
      location?: string;
      meetLink?: string;
    },
  ): Promise<void> {
    if (!recipients.length) return;
    try {
      await this.mail.sendEventUpdate({
        to: recipients,
        eventTitle: ctx.title,
        whenText: this.whenText(ctx.start),
        changesText: ctx.changesText,
        meetingType: ctx.meetingType === MeetingType.VIRTUAL ? 'virtual' : 'physical',
        location: ctx.location,
        meetLink: ctx.meetLink,
      });
    } catch (err) {
      this.logger.warn(`failed to email event update: ${err}`);
    }
  }

  /**
   * Normalise an incoming participant. Casts `userId` to ObjectId (when
   * present) and ensures the status defaults to INVITED.
   */
  private normaliseParticipant(p: ParticipantInputDto) {
    return {
      userType: p.userType,
      userId: p.userId ? new Types.ObjectId(p.userId) : undefined,
      name: p.name,
      email: p.email ?? '',
      status: p.status ?? ParticipantStatus.INVITED,
      invitedAt: new Date(),
    };
  }

  /**
   * Best-effort note onto a linked lead's timeline so the Leads tab captures
   * every event tied to the lead (and the Buyer Portal can surface them). Never
   * throws — a timeline failure must not break event create/update/delete.
   */
  private async pushLeadTimeline(
    leadId: string | undefined,
    action: string,
    by?: string,
  ): Promise<void> {
    if (!leadId || !Types.ObjectId.isValid(leadId)) return;
    try {
      await this.leadModel.updateOne(
        { _id: new Types.ObjectId(leadId), isDeleted: false },
        { $push: { timeline: { date: new Date(), action, by: by ?? '' } } },
      );
    } catch (err) {
      this.logger.warn(`failed to push lead timeline leadId=${leadId}: ${err}`);
    }
  }

  /** Human-readable "when" for a timeline note. */
  private whenLabel(d: Date | string): string {
    return new Date(d).toLocaleString();
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async create(
    dto: CreateCalendarEventDto,
    actorId?: string,
  ): Promise<CalendarEventDocument> {
    // Every event MUST have an assigned staff member. When the client doesn't
    // pick one, default to the creator (self) — the product requirement.
    const assignedToId = dto.assignedTo || actorId;

    // Provision a REAL Google Meet link for virtual events when requested.
    // GoogleMeetService inserts a Google Calendar event with conferenceData
    // and returns the genuine meet.google.com room + the Google event id.
    // If a link was REQUESTED but couldn't be created (Google not configured
    // or the API failed) we now BLOCK the create with an error instead of
    // silently saving a linkless event — the dealer asked to be told.
    const shouldGenerateMeet =
      dto.meetingType === MeetingType.VIRTUAL && dto.createMeetLink === true;
    let meetLink = dto.meetLink ?? '';
    let googleEventId = '';
    if (shouldGenerateMeet) {
      const meet = await this.googleMeet.createMeetEvent({
        title: dto.title,
        description: dto.description,
        startISO: new Date(dto.startDateTime).toISOString(),
        endISO: new Date(dto.endDateTime).toISOString(),
      });
      if (meet && meet.meetLink) {
        meetLink = meet.meetLink;
        googleEventId = meet.googleEventId;
      } else {
        throw new ServiceUnavailableException(MEET_UNAVAILABLE_MSG);
      }
    }

    const participants = (dto.participants ?? []).map((p) => this.normaliseParticipant(p));

    const saved = await new this.model({
      title: dto.title,
      description: dto.description ?? '',
      startDateTime: new Date(dto.startDateTime),
      endDateTime: new Date(dto.endDateTime),
      eventType: dto.eventType,
      status: dto.status,
      meetingType: dto.meetingType ?? MeetingType.PHYSICAL,
      meetLink,
      googleEventId,
      assignedTo: assignedToId ? new Types.ObjectId(assignedToId) : undefined,
      // Capture who created this event. Set from the controller via the
      // authenticated user, NOT from the DTO — client-supplied creator
      // would be a forgeable identity claim.
      createdBy: actorId ? new Types.ObjectId(actorId) : undefined,
      customerName: dto.customerName ?? '',
      customerPhone: dto.customerPhone ?? '',
      customerEmail: dto.customerEmail ?? '',
      vehicle: dto.vehicle ? new Types.ObjectId(dto.vehicle) : undefined,
      lead: dto.lead ? new Types.ObjectId(dto.lead) : undefined,
      location: dto.location ?? '',
      notes: dto.notes ?? '',
      participants,
    }).save();

    try {
      await this.activity.log({
        module: 'calendar',
        action: 'created',
        entity: 'Calendar Event',
        entityId: saved._id,
        label: `${labelFor(saved.eventType)} · ${saved.title || saved.customerName || 'event'} · ${new Date(saved.startDateTime).toLocaleString()}`,
        meta: {
          eventType: saved.eventType,
          meetingType: saved.meetingType,
          startDateTime: saved.startDateTime,
          participantCount: saved.participants.length,
          lead: saved.lead ? String(saved.lead) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for calendar create id=${saved._id}: ${err}`);
    }

    // Capture the event on the linked lead's timeline (best-effort).
    if (saved.lead) {
      await this.pushLeadTimeline(
        String(saved.lead),
        `${labelFor(saved.eventType)} scheduled · ${saved.title || 'event'} · ${this.whenLabel(saved.startDateTime)}`,
        actorId,
      );
    }

    // Invite everyone (assignee + participants + customer) — physical OR
    // virtual. Best-effort; a mail failure never rolls back the saved event.
    const inviteRecipients = await this.assembleAttendees({
      assignedTo: assignedToId,
      customerEmail: saved.customerEmail,
      participants: dto.participants,
    });
    await this.emailEventInvitation(inviteRecipients, {
      title: saved.title,
      start: saved.startDateTime,
      meetingType: saved.meetingType,
      location: saved.location,
      meetLink: saved.meetLink,
    });

    return saved;
  }

  async findAll(query: any): Promise<PaginatedResult<CalendarEventDocument>> {
    const {
      page = 1,
      limit = 50,
      sort = 'startDateTime',
      eventType,
      startDate,
      endDate,
      userId,
      userType,
    } = query;
    const skip = (page - 1) * limit;

    const filter: FilterQuery<CalendarEventDocument> = { isDeleted: false };
    if (eventType) filter.eventType = eventType;
    if (startDate || endDate) {
      filter.startDateTime = {};
      if (startDate) (filter.startDateTime as any).$gte = new Date(startDate);
      if (endDate) (filter.startDateTime as any).$lte = new Date(endDate);
    }

    /*
     * Multi-user calendar view — when the UI selects "view calendar of
     * <user>", we match events where ANY of these is the target user:
     *   - createdBy        (creator — only ever staff)
     *   - assignedTo       (lead staff — only ever staff)
     *   - participants[].userId  (any role)
     *
     * For Buyer/Seller the createdBy/assignedTo checks are harmless (no
     * match — those fields only ever hold staff ids), so we apply them
     * unconditionally and let the OR collapse.
     */
    if (userId && Types.ObjectId.isValid(userId)) {
      const oid = new Types.ObjectId(userId);
      const userOr: FilterQuery<CalendarEventDocument>[] = [
        { 'participants.userId': oid },
      ];
      // The staff-only clauses. Skip when caller has explicitly told us
      // this is a buyer/seller — cheap optimisation, not a correctness fix.
      if (!userType || userType === 'staff') {
        userOr.push({ assignedTo: oid });
        userOr.push({ createdBy: oid });
      }
      filter.$or = userOr;
    }

    const sortObj: any = sort.startsWith('-')
      ? { [sort.slice(1)]: -1 }
      : { [sort]: 1 };

    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('assignedTo', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .populate('vehicle', 'title vehicleNumber')
        .lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as unknown as CalendarEventDocument[], total, page, limit);
  }

  async findById(id: string): Promise<CalendarEventDocument> {
    const event = await this.model
      .findOne({ _id: id, isDeleted: false })
      .populate('assignedTo', 'firstName lastName email')
      .populate('createdBy', 'firstName lastName email')
      .populate('vehicle', 'title vehicleNumber');
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async update(
    id: string,
    dto: UpdateCalendarEventDto,
    actor?: CalendarActor,
  ): Promise<CalendarEventDocument> {
    const actorId = actor?.id;
    // Load the existing event first — the Google-Meet sync below needs the
    // current googleEventId / meetingType / attendees to decide whether to
    // create, patch, or cancel the backing Google Calendar event.
    const existing = await this.model.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Event not found');

    // Only the creator, the assigned staff member, or an admin may edit.
    if (!this.canManageEvent(existing, actor)) {
      throw new ForbiddenException(
        'Only the event creator or assigned staff can edit this event',
      );
    }

    const $set: Record<string, unknown> = { ...dto };
    if (dto.startDateTime) $set.startDateTime = new Date(dto.startDateTime);
    if (dto.endDateTime) $set.endDateTime = new Date(dto.endDateTime);
    if (dto.assignedTo) $set.assignedTo = new Types.ObjectId(dto.assignedTo);
    if (dto.vehicle) $set.vehicle = new Types.ObjectId(dto.vehicle);
    if (dto.lead) $set.lead = new Types.ObjectId(dto.lead);

    if (dto.participants) {
      $set.participants = dto.participants.map((p) => this.normaliseParticipant(p));
    }

    // ── Google Meet sync ───────────────────────────────────────────────────
    // Post-merge meeting type drives the decision. `createMeetLink` is the
    // trigger to (re)provision a real link. Only runs when Google is enabled;
    // dev mode leaves everything untouched (no fake links).
    const effectiveMeetingType = dto.meetingType ?? existing.meetingType;
    const wantsLink =
      dto.createMeetLink === true && effectiveMeetingType === MeetingType.VIRTUAL;

    if (this.googleMeet.isEnabled()) {
      const meetInput = {
        title: dto.title ?? existing.title,
        description: dto.description ?? existing.description,
        startISO: new Date(dto.startDateTime ?? existing.startDateTime).toISOString(),
        endISO: new Date(dto.endDateTime ?? existing.endDateTime).toISOString(),
      };

      if (effectiveMeetingType === MeetingType.PHYSICAL && existing.googleEventId) {
        // No longer virtual → cancel the backing Google event + clear refs.
        await this.googleMeet.deleteMeetEvent(existing.googleEventId);
        $set.meetLink = '';
        $set.googleEventId = '';
      } else if (
        effectiveMeetingType === MeetingType.VIRTUAL &&
        existing.googleEventId
      ) {
        // Keep the backing event's time/title in sync; regenerate the link
        // only if the user re-ticked "Create Google Meet link".
        const res = await this.googleMeet.updateMeetEvent(existing.googleEventId, {
          ...meetInput,
          regenerateLink: wantsLink,
        });
        if (res?.meetLink && wantsLink) {
          $set.meetLink = res.meetLink;
        }
      } else if (wantsLink) {
        // Virtual, no backing Google event yet → provision one now.
        const res = await this.googleMeet.createMeetEvent(meetInput);
        if (res && res.meetLink) {
          $set.meetLink = res.meetLink;
          $set.googleEventId = res.googleEventId;
        }
      }
    }
    // Strip the trigger flag — it's not a persisted field.
    delete ($set as any).createMeetLink;

    // A Meet link was REQUESTED but none resulted (Google disabled/failed and
    // nothing pasted) → block the update with an error, mirroring create.
    if (wantsLink) {
      const resultingLink =
        $set.meetLink !== undefined ? String($set.meetLink) : existing.meetLink;
      if (!resultingLink) {
        throw new ServiceUnavailableException(MEET_UNAVAILABLE_MSG);
      }
    }

    const event = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set },
      { new: true },
    );
    if (!event) throw new NotFoundException('Event not found');

    try {
      await this.activity.log({
        module: 'calendar',
        action: 'updated',
        entity: 'Calendar Event',
        entityId: event._id,
        label: `${labelFor(event.eventType)} updated · ${event.title || event.customerName || 'event'}`,
        meta: { fields: Object.keys(dto) },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for calendar update id=${id}: ${err}`);
    }

    // ── Attendee emails ────────────────────────────────────────────────────
    // Diff the attendee set before vs after the edit so we can:
    //   • send a fresh INVITATION to anyone newly involved (a newly-added
    //     participant, or a staff member the event was just re-assigned to);
    //   • send a single UPDATE to the CONTINUING attendees when the timing
    //     changed and/or the event was converted physical↔virtual (or the link
    //     regenerated). Newly-invited people get only the invitation, never a
    //     duplicate update. Best-effort throughout.
    const beforeEmails = new Set(
      await this.assembleAttendees({
        assignedTo: existing.assignedTo ? String(existing.assignedTo) : undefined,
        customerEmail: existing.customerEmail,
        participants: existing.participants,
      }),
    );
    const afterEmails = await this.assembleAttendees({
      assignedTo: event.assignedTo ? String(event.assignedTo) : undefined,
      customerEmail: event.customerEmail,
      participants: event.participants,
    });
    const newlyInvited = afterEmails.filter((e) => !beforeEmails.has(e));
    const continuing = afterEmails.filter((e) => beforeEmails.has(e));

    // Newly-added participant(s) or a new assignee → fresh invitation.
    await this.emailEventInvitation(newlyInvited, {
      title: event.title,
      start: event.startDateTime,
      meetingType: event.meetingType,
      location: event.location,
      meetLink: event.meetLink,
    });

    // Timing / conversion / link change → single update to continuing attendees.
    const timeChanged =
      !!dto.startDateTime &&
      new Date(dto.startDateTime).getTime() !== new Date(existing.startDateTime).getTime();
    const meetingTypeChanged =
      !!dto.meetingType && dto.meetingType !== existing.meetingType;
    const linkChanged =
      $set.meetLink !== undefined && String($set.meetLink) !== (existing.meetLink ?? '');
    if (timeChanged || meetingTypeChanged || linkChanged) {
      const changes: string[] = [];
      if (meetingTypeChanged) {
        changes.push(
          `The meeting is now ${effectiveMeetingType === MeetingType.VIRTUAL ? 'virtual' : 'physical'}`,
        );
      }
      if (timeChanged) changes.push('The time has changed');
      if (linkChanged && !meetingTypeChanged && !timeChanged) {
        changes.push('The meeting link has changed');
      }
      await this.emailEventUpdate(continuing, {
        title: event.title,
        start: event.startDateTime,
        changesText: `${changes.join('. ')}.`,
        meetingType: event.meetingType,
        location: event.location,
        meetLink: event.meetLink,
      });
    }

    // Mirror meaningful changes onto the linked lead's timeline (best-effort).
    // effectiveLead = the lead this event is tied to after the update (a
    // newly-supplied one, else the one it already had).
    const effectiveLead =
      dto.lead ?? (existing.lead ? String(existing.lead) : undefined);
    if (effectiveLead) {
      const newlyLinked = !!dto.lead && String(existing.lead ?? '') !== String(dto.lead);
      const timeChanged =
        !!dto.startDateTime &&
        new Date(dto.startDateTime).getTime() !== new Date(existing.startDateTime).getTime();
      const statusChanged = !!dto.status && dto.status !== existing.status;
      let note: string | undefined;
      if (newlyLinked) {
        note = `${labelFor(event.eventType)} linked · ${event.title || 'event'} · ${this.whenLabel(event.startDateTime)}`;
      } else if (timeChanged) {
        note = `${labelFor(event.eventType)} rescheduled to ${this.whenLabel(event.startDateTime)}`;
      } else if (statusChanged) {
        note = `${labelFor(event.eventType)} marked ${event.status}`;
      }
      if (note) await this.pushLeadTimeline(effectiveLead, note, actorId);
    }

    return event;
  }

  async remove(id: string, actor?: CalendarActor): Promise<void> {
    const actorId = actor?.id;
    // Authorize against the live event BEFORE soft-deleting: only the creator,
    // the assigned staff member, or an admin may delete.
    const target = await this.model.findOne({ _id: id, isDeleted: false });
    if (!target) throw new NotFoundException('Event not found');
    if (!this.canManageEvent(target, actor)) {
      throw new ForbiddenException(
        'Only the event creator or assigned staff can delete this event',
      );
    }

    const event = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
      { new: false },
    );
    if (!event) throw new NotFoundException('Event not found');

    // Cancel the backing Google Calendar event (best-effort) so the Meet room
    // and any sent invites don't outlive the CDMS event.
    if (event.googleEventId) {
      await this.googleMeet.deleteMeetEvent(event.googleEventId);
    }

    // Note the cancellation on the linked lead's timeline (best-effort).
    if (event.lead) {
      await this.pushLeadTimeline(
        String(event.lead),
        `${labelFor(event.eventType)} cancelled · ${event.title || 'event'} · ${this.whenLabel(event.startDateTime)}`,
        actorId,
      );
    }

    try {
      await this.activity.log({
        module: 'calendar',
        action: 'deleted',
        entity: 'Calendar Event',
        entityId: event._id,
        label: `${labelFor(event.eventType)} cancelled · ${event.title || event.customerName || 'event'}`,
      });
    } catch (err) {
      this.logger.warn(`activity log failed for calendar delete id=${id}: ${err}`);
    }
  }

  async getUpcoming(days = 7): Promise<CalendarEventDocument[]> {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.model
      .find({ isDeleted: false, startDateTime: { $gte: now, $lte: future } })
      .sort({ startDateTime: 1 })
      .populate('assignedTo', 'firstName lastName')
      .lean() as any;
  }

  // ── Participant management ──────────────────────────────────────────────

  async addParticipant(
    eventId: string,
    dto: ParticipantInputDto,
  ): Promise<CalendarEventDocument> {
    const normalised = this.normaliseParticipant(dto);
    const event = await this.model.findOneAndUpdate(
      { _id: eventId, isDeleted: false },
      { $push: { participants: normalised } },
      { new: true },
    );
    if (!event) throw new NotFoundException('Event not found');

    try {
      await this.activity.log({
        module: 'calendar',
        action: 'participant-added',
        entity: 'Calendar Event',
        entityId: event._id,
        label: `${normalised.name} (${normalised.userType}) added to ${event.title || 'event'}`,
        meta: { userType: normalised.userType, userId: normalised.userId?.toString() },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for participant-add: ${err}`);
    }
    return event;
  }

  async removeParticipant(
    eventId: string,
    participantId: string,
  ): Promise<CalendarEventDocument> {
    if (!Types.ObjectId.isValid(participantId)) {
      throw new BadRequestException('Invalid participant id');
    }
    const event = await this.model.findOneAndUpdate(
      { _id: eventId, isDeleted: false },
      { $pull: { participants: { _id: new Types.ObjectId(participantId) } } },
      { new: true },
    );
    if (!event) throw new NotFoundException('Event not found');

    try {
      await this.activity.log({
        module: 'calendar',
        action: 'participant-removed',
        entity: 'Calendar Event',
        entityId: event._id,
        label: `Participant removed from ${event.title || 'event'}`,
        meta: { participantId },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for participant-remove: ${err}`);
    }
    return event;
  }

  // ── Directory ───────────────────────────────────────────────────────────

  /**
   * Minimal attendee directory for the calendar UI — staff, buyers, sellers,
   * and leads (id + name + email only). Gated by `Calendar:view` so a user
   * with calendar access can populate the "view calendar of" combobox, the
   * participant picker, and the link-to-lead dropdown WITHOUT needing Staff /
   * CRM Buyers / CRM Sellers / Leads read permissions (which the CRM list
   * endpoints require and which non-admin calendar roles lack — the root of
   * the empty-picker bugs).
   */
  async getDirectory(): Promise<{
    staff: { id: string; name: string; email: string }[];
    buyers: { id: string; name: string; email: string; phone: string }[];
    sellers: { id: string; name: string; email: string; phone: string }[];
    leads: {
      id: string;
      buyerId: string;
      buyerName: string;
      buyerEmail: string;
      buyerPhone: string;
      vehicleId: string;
      vehicleTitle: string;
      status: string;
    }[];
  }> {
    const [staffDocs, buyerDocs, sellerDocs, leadDocs] = await Promise.all([
      this.userModel
        .find({ isDeleted: false })
        .select('firstName lastName email')
        .sort({ firstName: 1 })
        .lean(),
      this.buyerModel
        .find({ isDeleted: false })
        .select('buyerName buyerEmail buyerPhone')
        .sort({ buyerName: 1 })
        .lean(),
      this.sellerModel
        .find({ isDeleted: false })
        .select('sellerName sellerEmail sellerPhone')
        .sort({ sellerName: 1 })
        .lean(),
      this.leadModel
        .find({ isDeleted: false })
        .populate('buyer', 'buyerName buyerEmail buyerPhone')
        .populate('vehicle', 'title')
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
    ]);

    return {
      staff: (staffDocs as any[]).map((s) => ({
        id: String(s._id),
        name: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() || (s.email ?? ''),
        email: s.email ?? '',
      })),
      buyers: (buyerDocs as any[]).map((b) => ({
        id: String(b._id),
        name: b.buyerName ?? '',
        email: b.buyerEmail ?? '',
        phone: b.buyerPhone ?? '',
      })),
      sellers: (sellerDocs as any[]).map((s) => ({
        id: String(s._id),
        name: s.sellerName ?? '',
        email: s.sellerEmail ?? '',
        phone: s.sellerPhone ?? '',
      })),
      leads: (leadDocs as any[]).map((l) => {
        const buyer = l.buyer && typeof l.buyer === 'object' ? l.buyer : null;
        const vehicle = l.vehicle && typeof l.vehicle === 'object' ? l.vehicle : null;
        return {
          id: String(l._id),
          buyerId: buyer ? String(buyer._id) : l.buyer ? String(l.buyer) : '',
          buyerName: buyer?.buyerName ?? '—',
          buyerEmail: buyer?.buyerEmail ?? '',
          buyerPhone: buyer?.buyerPhone ?? '',
          vehicleId: vehicle ? String(vehicle._id) : l.vehicle ? String(l.vehicle) : '',
          vehicleTitle: vehicle?.title ?? '—',
          status: l.status ?? '',
        };
      }),
    };
  }
}

/** Render the eventType enum slug as a human-readable verb. */
function labelFor(type: string): string {
  switch (type) {
    case EventType.TEST_DRIVE:
      return 'Test drive';
    case EventType.INSPECTION:
      return 'Inspection';
    case EventType.MEETING:
      return 'Meeting';
    case EventType.OTHER:
      return 'Other event';
    default:
      return 'Event';
  }
}
