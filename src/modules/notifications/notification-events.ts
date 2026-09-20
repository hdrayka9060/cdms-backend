/**
 * Domain → notification event contract. Feature services `emit` these on the
 * global EventEmitter2 bus (right beside their existing ActivityService.log
 * calls); the NotificationsListener is the only subscriber and maps each to a
 * NotificationsService.notify() call. This keeps feature modules ignorant of
 * notification logic and recipients, and makes delivery best-effort/async
 * (a listener error can never fail the originating request).
 */
export const NotificationEvent = {
  /** A lead was (re)assigned to a staff member. Notify the new owner. */
  LEAD_ASSIGNED: 'lead.assigned',
  /** A new lead was opened from a public website form. Notify the sales team. */
  LEAD_WEBSITE_CREATED: 'lead.website-created',
  /** A new lead was created in the admin Leads tab. Notify everyone who can view
   *  Leads (assignee + the sales team; the creator is excluded). */
  LEAD_CREATED: 'lead.created',
  /** A calendar appointment (test drive / inspection / meeting) was booked for
   *  a staff member other than its creator. Notify the assignee. */
  APPOINTMENT_BOOKED: 'appointment.booked',
  /** A vehicle sale was recorded (via Record Sale / Mark Sold / Close Lead).
   *  Notify accounting + sales managers. */
  SALE_RECORDED: 'sale.recorded',
  /** An invited staff member set their password and joined. Notify staff admins. */
  USER_INVITE_ACCEPTED: 'user.invite-accepted',
  /** A calendar appointment's time / meeting type changed. Notify the assignee. */
  APPOINTMENT_UPDATED: 'appointment.updated',
  /** A calendar appointment was cancelled / deleted. Notify the assignee. */
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  /** A lead moved into Negotiation. Notify the rep + sales managers. */
  LEAD_NEGOTIATION: 'lead.negotiation',
  /** A real (non-dev) outbound email failed to send. Notify staff admins (ops). */
  MAIL_FAILED: 'system.mail-failed',
  /** A staff member's role was changed. Notify the affected user (security). */
  USER_ROLE_CHANGED: 'user.role-changed',
  /** A new support ticket was raised. Notify support staff. */
  SUPPORT_TICKET_CREATED: 'support.ticket-created',
  /** An ad-account sync failed (healthy→failing). Notify marketing + ops. */
  ADS_SYNC_FAILED: 'ads.sync-failed',
  /** An appointment is starting soon (reminder cron). Notify the assignee. */
  APPOINTMENT_REMINDER: 'appointment.reminder',
  /** An open lead has gone quiet for too long (reminder cron). Notify the rep. */
  LEAD_STALE: 'lead.stale',
  /** A BHPH loan payment was recorded. Notify BHPH staff (+ borrower receipt). */
  BHPH_PAYMENT_RECORDED: 'bhph.payment-recorded',
  /** A BHPH installment is due soon (reminder cron). Notify staff + borrower. */
  BHPH_PAYMENT_DUE: 'bhph.payment-due',
  /** A BHPH installment is past due (reminder cron). Notify staff + borrower. */
  BHPH_PAYMENT_OVERDUE: 'bhph.payment-overdue',
  /** A BHPH loan was fully paid off. Notify staff + borrower. */
  BHPH_LOAN_PAID_OFF: 'bhph.loan-paid-off',
} as const;

export interface LeadAssignedEvent {
  leadId: string;
  /** User id the lead is now assigned to. */
  assigneeId: string;
  /** Who made the change (excluded from their own notification). */
  actorId?: string;
  actorName?: string;
  vehicleTitle?: string;
  buyerName?: string;
}

export interface LeadWebsiteCreatedEvent {
  leadId: string;
  buyerName?: string;
  vehicleTitle?: string;
  /** e.g. "Contact Enquiry" / "Finance Application" — the form the lead came from. */
  formLabel?: string;
}

export interface LeadCreatedEvent {
  leadId: string;
  buyerName?: string;
  vehicleTitle?: string;
  /** The rep the lead was assigned to at creation (often the creator). */
  assigneeId?: string;
  /** Who created the lead (excluded from their own notification). */
  actorId?: string;
  actorName?: string;
  /** Lead source label, e.g. "Walk-in" / "Referral". */
  source?: string;
}

export interface AppointmentBookedEvent {
  eventId: string;
  assigneeId: string;
  actorId?: string;
  /** Human label for the appointment type, e.g. "Test Drive". */
  eventLabel?: string;
  title?: string;
  customerName?: string;
  startISO?: string;
}

export interface SaleRecordedEvent {
  saleId: string;
  vehicleTitle?: string;
  buyerName?: string;
  net?: number;
  actorId?: string;
  actorName?: string;
}

export interface UserInviteAcceptedEvent {
  userId: string;
  name: string;
  email?: string;
}

export interface AppointmentChangedEvent {
  eventId: string;
  assigneeId: string;
  actorId?: string;
  eventLabel?: string;
  title?: string;
  startISO?: string;
  /** Short summary of what changed, e.g. "New time" (updated only). */
  change?: string;
}

export interface LeadNegotiationEvent {
  leadId: string;
  assigneeId?: string;
  actorId?: string;
  actorName?: string;
  vehicleTitle?: string;
  buyerName?: string;
}

export interface MailFailedEvent {
  /** The mail context tag, e.g. "website-inquiry" / "invite". */
  contextTag: string;
  to: string;
  reason: string;
}

export interface UserRoleChangedEvent {
  userId: string;
  roleName: string;
  actorId?: string;
}

export interface SupportTicketCreatedEvent {
  ticketId: string;
  subject: string;
  raisedByName?: string;
  priority?: string;
}

export interface AdsSyncFailedEvent {
  provider: string;
  connectionId: string;
  accountName?: string;
  reason: string;
}

export interface AppointmentReminderEvent {
  eventId: string;
  assigneeId: string;
  eventLabel?: string;
  title?: string;
  customerName?: string;
  startISO?: string;
}

export interface LeadStaleEvent {
  leadId: string;
  assigneeId: string;
  buyerName?: string;
  vehicleTitle?: string;
  idleDays?: number;
}

export interface BhphPaymentRecordedEvent {
  loanId: string;
  borrowerName?: string;
  borrowerEmail?: string;
  vehicleTitle?: string;
  amount?: number;
  actorId?: string;
  actorName?: string;
}

export interface BhphPaymentDueEvent {
  loanId: string;
  borrowerName?: string;
  borrowerEmail?: string;
  vehicleTitle?: string;
  /** YYYY-MM-DD of the installment due date. */
  dueDate?: string;
  amount?: number;
}

export interface BhphPaymentOverdueEvent {
  loanId: string;
  borrowerName?: string;
  borrowerEmail?: string;
  vehicleTitle?: string;
  dueDate?: string;
  daysLate?: number;
  amount?: number;
}

export interface BhphLoanPaidOffEvent {
  loanId: string;
  borrowerName?: string;
  borrowerEmail?: string;
  vehicleTitle?: string;
}
