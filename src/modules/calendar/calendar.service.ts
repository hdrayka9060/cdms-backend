import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
    private readonly activity: ActivityService,
    private readonly googleMeet: GoogleMeetService,
    private readonly mail: MailService,
  ) {}

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
   * Email the Meet link to everyone on the event (assignee + participants +
   * customer). This replaces Google Calendar invites — the dealer wants the
   * link delivered without creating calendar invites. Best-effort: a mail
   * failure must never break event creation.
   */
  private async emailMeetingLink(
    meetLink: string,
    ctx: {
      title: string;
      startISO: string;
      assignedTo?: string;
      customerEmail?: string;
      participants?: { email?: string }[];
    },
  ): Promise<void> {
    if (!meetLink) return;
    try {
      const recipients = await this.assembleAttendees({
        assignedTo: ctx.assignedTo,
        customerEmail: ctx.customerEmail,
        participants: ctx.participants,
      });
      if (recipients.length === 0) return;
      await this.mail.sendMeetingLink({
        to: recipients,
        eventTitle: ctx.title,
        whenText: new Date(ctx.startISO).toLocaleString('en-US', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        meetLink,
      });
    } catch (err) {
      this.logger.warn(`failed to email meeting link: ${err}`);
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

  // ── CRUD ────────────────────────────────────────────────────────────────

  async create(
    dto: CreateCalendarEventDto,
    actorId?: string,
  ): Promise<CalendarEventDocument> {
    // Provision a REAL Google Meet link for virtual events when requested.
    // GoogleMeetService inserts a Google Calendar event with conferenceData
    // and returns the genuine meet.google.com room + the Google event id.
    // In dev mode (no Google creds) it returns null and we fall back to any
    // pasted link — never a fabricated one. Physical events keep `location`.
    const shouldGenerateMeet =
      dto.meetingType === MeetingType.VIRTUAL && dto.createMeetLink === true;
    let meetLink = dto.meetLink ?? '';
    let googleEventId = '';
    if (shouldGenerateMeet) {
      const startISO = new Date(dto.startDateTime).toISOString();
      const meet = await this.googleMeet.createMeetEvent({
        title: dto.title,
        description: dto.description,
        startISO,
        endISO: new Date(dto.endDateTime).toISOString(),
      });
      if (meet) {
        meetLink = meet.meetLink;
        googleEventId = meet.googleEventId;
        // Email the link to everyone — NO Google Calendar invite is sent.
        await this.emailMeetingLink(meetLink, {
          title: dto.title,
          startISO,
          assignedTo: dto.assignedTo,
          customerEmail: dto.customerEmail,
          participants: dto.participants,
        });
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
      assignedTo: dto.assignedTo ? new Types.ObjectId(dto.assignedTo) : undefined,
      // Capture who created this event. Set from the controller via the
      // authenticated user, NOT from the DTO — client-supplied creator
      // would be a forgeable identity claim.
      createdBy: actorId ? new Types.ObjectId(actorId) : undefined,
      customerName: dto.customerName ?? '',
      customerPhone: dto.customerPhone ?? '',
      customerEmail: dto.customerEmail ?? '',
      vehicle: dto.vehicle ? new Types.ObjectId(dto.vehicle) : undefined,
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
        },
      });
    } catch (err) {
      this.logger.warn(`activity log failed for calendar create id=${saved._id}: ${err}`);
    }

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

  async update(id: string, dto: UpdateCalendarEventDto): Promise<CalendarEventDocument> {
    // Load the existing event first — the Google-Meet sync below needs the
    // current googleEventId / meetingType / attendees to decide whether to
    // create, patch, or cancel the backing Google Calendar event.
    const existing = await this.model.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Event not found');

    const $set: Record<string, unknown> = { ...dto };
    if (dto.startDateTime) $set.startDateTime = new Date(dto.startDateTime);
    if (dto.endDateTime) $set.endDateTime = new Date(dto.endDateTime);
    if (dto.assignedTo) $set.assignedTo = new Types.ObjectId(dto.assignedTo);
    if (dto.vehicle) $set.vehicle = new Types.ObjectId(dto.vehicle);

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
      // Recipients for the link email (no Google calendar invite is sent).
      const mailCtx = {
        title: meetInput.title,
        startISO: meetInput.startISO,
        assignedTo:
          dto.assignedTo ??
          (existing.assignedTo ? String(existing.assignedTo) : undefined),
        customerEmail: dto.customerEmail ?? existing.customerEmail,
        participants: dto.participants ?? existing.participants,
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
          await this.emailMeetingLink(res.meetLink, mailCtx);
        }
      } else if (wantsLink) {
        // Virtual, no backing Google event yet → provision one now.
        const res = await this.googleMeet.createMeetEvent(meetInput);
        if (res) {
          $set.meetLink = res.meetLink;
          $set.googleEventId = res.googleEventId;
          await this.emailMeetingLink(res.meetLink, mailCtx);
        }
      }
    }
    // Strip the trigger flag — it's not a persisted field.
    delete ($set as any).createMeetLink;

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

    return event;
  }

  async remove(id: string): Promise<void> {
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
