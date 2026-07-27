import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type CalendarEventDocument = CalendarEvent & Document;

/**
 * Event types.
 *
 * `OTHER` replaces the previous `BLOCKED` slot. Block-slot semantics are now
 * just a regular event with `eventType: OTHER` — the user explicitly asked
 * for this rename. A boot migrator in `calendar.migrator.ts` rewrites any
 * legacy `blocked` rows to `other` so existing data keeps loading.
 */
export enum EventType {
  TEST_DRIVE = 'test_drive',
  INSPECTION = 'inspection',
  MEETING = 'meeting',
  OTHER = 'other',
}

export enum EventStatus {
  SCHEDULED = 'scheduled',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

/**
 * Distinguishes events held in-person from those held over a video call.
 * Drives the "Create Google Meet" affordance on the event form — physical
 * meetings hide the toggle since a Meet link makes no sense there.
 */
export enum MeetingType {
  PHYSICAL = 'physical',
  VIRTUAL = 'virtual',
}

/** A participant on an event. Can reference any of three CRM entities. */
export enum ParticipantType {
  STAFF = 'staff',
  BUYER = 'buyer',
  SELLER = 'seller',
}

export enum ParticipantStatus {
  INVITED = 'invited',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
}

/**
 * Inline subdoc — no ref population in mongoose because the three target
 * collections (users/buyer_leads/seller_leads) are different shapes. We
 * captured `name` + `email` at the time of invite so the list renders even
 * if the source record was later renamed or deleted.
 *
 * NOTE on subdoc syntax: every nested field uses `{ type: X }` explicitly.
 * Mongoose's shorthand `{ type: String, name: String }` collapses the entire
 * subdoc to a SchemaType definition — the once-bitten bug documented in
 * PROJECT_MEMORY.md §3. Don't change this.
 */
const ParticipantSubSchema = {
  type: [
    {
      _id: { type: MongooseSchema.Types.ObjectId, auto: true },
      userType: { type: String, enum: Object.values(ParticipantType), required: true },
      // Optional — for ad-hoc invitees (an email-only contact) we may not
      // have a CRM record yet. When present it MUST be cast as ObjectId
      // (Schema.Types.ObjectId, not Types.ObjectId — see PROJECT_MEMORY.md
      // §3 on the silent Mixed-degradation bug).
      userId: { type: MongooseSchema.Types.ObjectId, required: false },
      name: { type: String, required: true },
      email: { type: String, default: '' },
      status: {
        type: String,
        enum: Object.values(ParticipantStatus),
        default: ParticipantStatus.INVITED,
      },
      invitedAt: { type: Date, default: Date.now },
    },
  ],
  default: [],
};

@Schema({ timestamps: true, collection: 'calendar_events' })
export class CalendarEvent {
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) description: string;
  @Prop({ required: true }) startDateTime: Date;
  @Prop({ required: true }) endDateTime: Date;

  @Prop({ type: String, enum: EventType, required: true }) eventType: EventType;
  @Prop({ type: String, enum: EventStatus, default: EventStatus.SCHEDULED }) status: EventStatus;

  // Owner / lead staff member. Use Schema.Types.ObjectId — the runtime
  // class (`Types.ObjectId`) silently degrades to Mixed and stops casting.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;

  // Who created this event. Set automatically by the controller from
  // `req.user._id` on POST. Used by the multi-user calendar filter so the
  // creator always sees their own events even if they didn't add themself
  // as a participant or assignee.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) createdBy: Types.ObjectId;

  // Free-text customer fields (kept for back-compat; participants is the
  // canonical place to track who's coming).
  @Prop({ default: '' }) customerName: string;
  @Prop({ default: '' }) customerPhone: string;
  @Prop({ default: '' }) customerEmail: string;

  // Linked vehicle for test drives & inspections.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Vehicle' }) vehicle: Types.ObjectId;

  // Optional link to a CRM Lead. When set, CalendarService pushes a note onto
  // the lead's timeline (create/update/delete) and the public Buyer Portal
  // lists this event under the buyer's appointments. Schema.Types.ObjectId —
  // never Types.ObjectId (silent Mixed degradation, PROJECT_MEMORY.md §3).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Lead' }) lead: Types.ObjectId;

  // ── Meeting location ───────────────────────────────────────────────────
  // `meetingType` separates physical from virtual. For virtual events the
  // service generates a Meet link when `createMeetLink: true` is passed at
  // create/update time. Physical events keep their `location` (address)
  // and have an empty meetLink.
  @Prop({ type: String, enum: MeetingType, default: MeetingType.PHYSICAL })
  meetingType: MeetingType;

  @Prop({ default: '' }) meetLink: string;

  // Id of the backing Google Calendar event (set when GoogleMeetService
  // provisions a real Meet link). Stored so the Google event can be patched
  // when this CDMS event is edited and cancelled when it's deleted. Empty for
  // physical events, paste-your-own links, and dev-mode (no Google creds).
  @Prop({ default: '' }) googleEventId: string;

  @Prop({ default: '' }) location: string;

  // ── Participants ───────────────────────────────────────────────────────
  // Multi-attendee list. Staff = user ref, Buyer = buyer_lead ref,
  // Seller = seller_lead ref. The userId is optional so an admin can also
  // add an unregistered email-only invitee.
  @Prop(ParticipantSubSchema)
  participants: {
    _id: Types.ObjectId;
    userType: ParticipantType;
    userId?: Types.ObjectId;
    name: string;
    email: string;
    status: ParticipantStatus;
    invitedAt: Date;
  }[];

  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const CalendarEventSchema = SchemaFactory.createForClass(CalendarEvent);

CalendarEventSchema.index({ startDateTime: 1, endDateTime: 1, eventType: 1 });
// Multi-user calendar view filters by assignedTo OR participants.userId.
// Index both so the OR query can use them.
CalendarEventSchema.index({ assignedTo: 1, startDateTime: 1 });
CalendarEventSchema.index({ 'participants.userId': 1, startDateTime: 1 });
// Buyer-portal + Leads-tab linkage: list/lookup events by their linked lead.
CalendarEventSchema.index({ lead: 1, startDateTime: 1 });
