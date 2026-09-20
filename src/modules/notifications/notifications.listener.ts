import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import { NotificationCategory } from './schemas/notification.schema';
import {
  NotificationEvent,
  LeadAssignedEvent,
  LeadCreatedEvent,
  LeadWebsiteCreatedEvent,
  AppointmentBookedEvent,
  SaleRecordedEvent,
  UserInviteAcceptedEvent,
  AppointmentChangedEvent,
  LeadNegotiationEvent,
  MailFailedEvent,
  UserRoleChangedEvent,
  SupportTicketCreatedEvent,
  AdsSyncFailedEvent,
  AppointmentReminderEvent,
  LeadStaleEvent,
  BhphPaymentRecordedEvent,
  BhphPaymentDueEvent,
  BhphPaymentOverdueEvent,
  BhphLoanPaidOffEvent,
} from './notification-events';
import { AppModule, PermissionAction } from '../../common/permissions';

/**
 * The sole subscriber to the domain → notification event bus. Each handler maps
 * one event to a NotificationsService.notify() call with its recipient spec.
 * `{ async: true }` runs handlers off the emitter's microtask queue so a slow
 * or failing handler never blocks the request that emitted the event.
 */
@Injectable()
export class NotificationsListener {
  constructor(private readonly notifications: NotificationsService) {}

  /** Lead (re)assigned → the new owner (in-app + email). */
  @OnEvent(NotificationEvent.LEAD_ASSIGNED, { async: true })
  async onLeadAssigned(e: LeadAssignedEvent): Promise<void> {
    if (!e.assigneeId) return;
    await this.notifications.notify(
      { assigneeId: e.assigneeId, excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'lead.assigned',
        category: NotificationCategory.LEADS,
        title: 'A lead was assigned to you',
        body:
          [e.buyerName, e.vehicleTitle].filter(Boolean).join(' — ') ||
          'Open the lead for details.',
        entity: { kind: 'lead', id: e.leadId },
        link: `/leads/${e.leadId}`,
        actorId: e.actorId,
        actorName: e.actorName,
        email: true, // high-value: the owner should get an email too
        meta: { vehicleTitle: e.vehicleTitle, buyerName: e.buyerName },
      },
    );
  }

  /** New lead created in the admin Leads tab → everyone who can view Leads
   *  (assignee + sales team; creator excluded). In-app only. */
  @OnEvent(NotificationEvent.LEAD_CREATED, { async: true })
  async onLeadCreated(e: LeadCreatedEvent): Promise<void> {
    await this.notifications.notify(
      {
        assigneeId: e.assigneeId ?? undefined,
        roleModules: [{ module: AppModule.LEADS, action: PermissionAction.VIEW }],
        excludeUserIds: e.actorId ? [e.actorId] : [],
      },
      {
        type: 'lead.new',
        category: NotificationCategory.LEADS,
        title: 'New lead created',
        body:
          [e.buyerName, e.vehicleTitle].filter(Boolean).join(' — ') ||
          `New ${e.source ?? ''} lead`.trim(),
        entity: { kind: 'lead', id: e.leadId },
        link: `/leads/${e.leadId}`,
        actorId: e.actorId,
        actorName: e.actorName,
        email: false,
        meta: { source: e.source },
      },
    );
  }

  /** New website lead → the whole sales team (anyone who can view Leads). In-app only. */
  @OnEvent(NotificationEvent.LEAD_WEBSITE_CREATED, { async: true })
  async onWebsiteLead(e: LeadWebsiteCreatedEvent): Promise<void> {
    await this.notifications.notify(
      { roleModules: [{ module: AppModule.LEADS, action: PermissionAction.VIEW }] },
      {
        type: 'lead.new',
        category: NotificationCategory.LEADS,
        title: 'New website lead',
        body:
          [e.buyerName, e.vehicleTitle && `interested in ${e.vehicleTitle}`]
            .filter(Boolean)
            .join(' — ') || `New ${e.formLabel ?? 'website'} enquiry`,
        entity: { kind: 'lead', id: e.leadId },
        link: `/leads/${e.leadId}`,
        email: false,
        meta: { formLabel: e.formLabel },
      },
    );
  }

  /** Appointment booked for a staff member → the assignee (in-app). */
  @OnEvent(NotificationEvent.APPOINTMENT_BOOKED, { async: true })
  async onAppointmentBooked(e: AppointmentBookedEvent): Promise<void> {
    if (!e.assigneeId) return;
    const when = e.startISO ? new Date(e.startISO).toLocaleString() : '';
    await this.notifications.notify(
      { assigneeId: e.assigneeId, excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'appointment.booked',
        category: NotificationCategory.APPOINTMENTS,
        title: `${e.eventLabel ?? 'Appointment'} booked for you`,
        body:
          [e.customerName || e.title, when].filter(Boolean).join(' · ') ||
          'Open the calendar for details.',
        entity: { kind: 'calendar', id: e.eventId },
        link: '/calendar',
        email: false,
        meta: { startISO: e.startISO },
      },
    );
  }

  /** Sale recorded → accounting staff + sales managers (in-app). */
  @OnEvent(NotificationEvent.SALE_RECORDED, { async: true })
  async onSaleRecorded(e: SaleRecordedEvent): Promise<void> {
    await this.notifications.notify(
      {
        roleModules: [
          { module: AppModule.ACCOUNTING, action: PermissionAction.VIEW },
          { module: AppModule.LEADS, action: PermissionAction.EDIT },
        ],
        excludeUserIds: e.actorId ? [e.actorId] : [],
      },
      {
        type: 'sale.recorded',
        category: NotificationCategory.SALES,
        title: 'Vehicle sold',
        body:
          `${e.vehicleTitle ?? 'A vehicle'} sold${e.buyerName ? ` to ${e.buyerName}` : ''}` +
          (typeof e.net === 'number' ? ` · $${e.net.toLocaleString()}` : ''),
        entity: { kind: 'sale', id: e.saleId },
        link: '/accounting',
        actorId: e.actorId,
        actorName: e.actorName,
        email: false,
      },
    );
  }

  /** Invited staff accepted → whoever manages staff (in-app). */
  @OnEvent(NotificationEvent.USER_INVITE_ACCEPTED, { async: true })
  async onInviteAccepted(e: UserInviteAcceptedEvent): Promise<void> {
    await this.notifications.notify(
      {
        roleModules: [{ module: AppModule.STAFF, action: PermissionAction.EDIT }],
        excludeUserIds: [e.userId],
      },
      {
        type: 'user.invite-accepted',
        category: NotificationCategory.SYSTEM,
        title: 'Staff invite accepted',
        body: `${e.name} has joined the team.`,
        entity: { kind: 'user', id: e.userId },
        link: '/staff',
        email: false,
      },
    );
  }

  /** Appointment time/type changed → the assignee (in-app). */
  @OnEvent(NotificationEvent.APPOINTMENT_UPDATED, { async: true })
  async onAppointmentUpdated(e: AppointmentChangedEvent): Promise<void> {
    if (!e.assigneeId) return;
    const when = e.startISO ? new Date(e.startISO).toLocaleString() : '';
    await this.notifications.notify(
      { assigneeId: e.assigneeId, excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'appointment.updated',
        category: NotificationCategory.APPOINTMENTS,
        title: `${e.eventLabel ?? 'Appointment'} updated`,
        body: [e.change, e.title, when].filter(Boolean).join(' · ') ||
          'Open the calendar for details.',
        entity: { kind: 'calendar', id: e.eventId },
        link: '/calendar',
        email: false,
      },
    );
  }

  /** Appointment cancelled/deleted → the assignee (in-app). */
  @OnEvent(NotificationEvent.APPOINTMENT_CANCELLED, { async: true })
  async onAppointmentCancelled(e: AppointmentChangedEvent): Promise<void> {
    if (!e.assigneeId) return;
    const when = e.startISO ? new Date(e.startISO).toLocaleString() : '';
    await this.notifications.notify(
      { assigneeId: e.assigneeId, excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'appointment.cancelled',
        category: NotificationCategory.APPOINTMENTS,
        title: `${e.eventLabel ?? 'Appointment'} cancelled`,
        body: [e.title, when].filter(Boolean).join(' · ') || 'An appointment was cancelled.',
        entity: { kind: 'calendar', id: e.eventId },
        link: '/calendar',
        email: false,
      },
    );
  }

  /** Lead entered Negotiation → the rep + sales managers (in-app). */
  @OnEvent(NotificationEvent.LEAD_NEGOTIATION, { async: true })
  async onLeadNegotiation(e: LeadNegotiationEvent): Promise<void> {
    await this.notifications.notify(
      {
        assigneeId: e.assigneeId ?? undefined,
        roleModules: [{ module: AppModule.LEADS, action: PermissionAction.EDIT }],
        excludeUserIds: e.actorId ? [e.actorId] : [],
      },
      {
        type: 'lead.negotiation',
        category: NotificationCategory.LEADS,
        title: 'Lead in negotiation',
        body:
          [e.buyerName, e.vehicleTitle].filter(Boolean).join(' — ') ||
          'A lead moved into negotiation.',
        entity: { kind: 'lead', id: e.leadId },
        link: `/leads/${e.leadId}`,
        actorId: e.actorId,
        actorName: e.actorName,
        email: false,
      },
    );
  }

  /** A real outbound email failed → staff admins (in-app ops alert). */
  @OnEvent(NotificationEvent.MAIL_FAILED, { async: true })
  async onMailFailed(e: MailFailedEvent): Promise<void> {
    await this.notifications.notify(
      { roleModules: [{ module: AppModule.STAFF, action: PermissionAction.EDIT }] },
      {
        type: 'system.mail-failed',
        category: NotificationCategory.SYSTEM,
        title: 'Email delivery failed',
        body: `A ${e.contextTag} email to ${e.to} could not be sent: ${e.reason}`.slice(0, 300),
        link: '',
        email: false, // in-app only — never email about an email failure (no loop)
        meta: { contextTag: e.contextTag, to: e.to },
      },
    );
  }

  /** A staff member's role was changed → the affected user (security, in-app). */
  @OnEvent(NotificationEvent.USER_ROLE_CHANGED, { async: true })
  async onRoleChanged(e: UserRoleChangedEvent): Promise<void> {
    await this.notifications.notify(
      { userIds: [e.userId], excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'user.role-changed',
        category: NotificationCategory.SYSTEM,
        title: 'Your role changed',
        body: `Your access level is now "${e.roleName}". Sign out and back in if a page looks different.`,
        entity: { kind: 'user', id: e.userId },
        link: '',
        email: false,
      },
    );
  }

  /** New support ticket → support staff (in-app). */
  @OnEvent(NotificationEvent.SUPPORT_TICKET_CREATED, { async: true })
  async onSupportTicket(e: SupportTicketCreatedEvent): Promise<void> {
    await this.notifications.notify(
      { roleModules: [{ module: AppModule.SUPPORT, action: PermissionAction.VIEW }] },
      {
        type: 'support.ticket-created',
        category: NotificationCategory.SUPPORT,
        title: 'New support ticket',
        body: [e.subject, e.raisedByName].filter(Boolean).join(' — ') || 'A support ticket was raised.',
        entity: { kind: 'ticket', id: e.ticketId },
        link: '/support',
        email: false,
        meta: { priority: e.priority },
      },
    );
  }

  /** Ad-account sync failed → marketing + ops (in-app). */
  @OnEvent(NotificationEvent.ADS_SYNC_FAILED, { async: true })
  async onAdsSyncFailed(e: AdsSyncFailedEvent): Promise<void> {
    await this.notifications.notify(
      {
        roleModules: [
          { module: AppModule.MARKETING, action: PermissionAction.EDIT },
          { module: AppModule.STAFF, action: PermissionAction.EDIT },
        ],
      },
      {
        type: 'ads.sync-failed',
        category: NotificationCategory.SOCIAL,
        title: 'Ad account sync failed',
        body: `${e.provider} (${e.accountName ?? 'account'}) couldn't sync: ${e.reason}`.slice(0, 300),
        entity: { kind: 'ads-connection', id: e.connectionId },
        link: '/marketing',
        email: false,
      },
    );
  }

  /** Appointment starting soon → the assignee (reminder cron, in-app). */
  @OnEvent(NotificationEvent.APPOINTMENT_REMINDER, { async: true })
  async onAppointmentReminder(e: AppointmentReminderEvent): Promise<void> {
    if (!e.assigneeId) return;
    const when = e.startISO ? new Date(e.startISO).toLocaleString() : '';
    await this.notifications.notify(
      { assigneeId: e.assigneeId },
      {
        type: 'appointment.reminder',
        category: NotificationCategory.APPOINTMENTS,
        title: `Upcoming: ${e.eventLabel ?? 'appointment'}`,
        body: [e.customerName || e.title, when].filter(Boolean).join(' · ') || 'Starting soon.',
        entity: { kind: 'calendar', id: e.eventId },
        link: '/calendar',
        email: false,
      },
    );
  }

  /** Open lead gone quiet → the owning rep (reminder cron, in-app). */
  @OnEvent(NotificationEvent.LEAD_STALE, { async: true })
  async onLeadStale(e: LeadStaleEvent): Promise<void> {
    if (!e.assigneeId) return;
    await this.notifications.notify(
      { assigneeId: e.assigneeId },
      {
        type: 'lead.stale',
        category: NotificationCategory.LEADS,
        title: 'Lead needs a follow-up',
        body:
          ([e.buyerName, e.vehicleTitle].filter(Boolean).join(' — ') || 'An open lead') +
          (e.idleDays ? ` · no activity for ${e.idleDays} days` : ''),
        entity: { kind: 'lead', id: e.leadId },
        link: `/leads/${e.leadId}`,
        email: false,
      },
    );
  }

  // ── BHPH financing (recipients = anyone who can view BHPH; in-app) ─────────
  private bhphSpec() {
    return { roleModules: [{ module: AppModule.BHPH, action: PermissionAction.VIEW }] };
  }
  private bhphBody(name?: string, vehicle?: string, tail?: string): string {
    return ([name, vehicle].filter(Boolean).join(' — ') || 'A BHPH loan') + (tail ? ` · ${tail}` : '');
  }

  /** BHPH payment recorded → BHPH staff (in-app). */
  @OnEvent(NotificationEvent.BHPH_PAYMENT_RECORDED, { async: true })
  async onBhphPaymentRecorded(e: BhphPaymentRecordedEvent): Promise<void> {
    await this.notifications.notify(
      { ...this.bhphSpec(), excludeUserIds: e.actorId ? [e.actorId] : [] },
      {
        type: 'bhph.payment-recorded',
        category: NotificationCategory.SALES,
        title: 'BHPH payment recorded',
        body: this.bhphBody(e.borrowerName, e.vehicleTitle, typeof e.amount === 'number' ? `$${e.amount.toLocaleString()}` : undefined),
        entity: { kind: 'loan', id: e.loanId },
        link: '/bhph',
        actorId: e.actorId,
        actorName: e.actorName,
        email: false,
      },
    );
  }

  /** BHPH installment due soon → BHPH staff (in-app). */
  @OnEvent(NotificationEvent.BHPH_PAYMENT_DUE, { async: true })
  async onBhphPaymentDue(e: BhphPaymentDueEvent): Promise<void> {
    await this.notifications.notify(this.bhphSpec(), {
      type: 'bhph.payment-due',
      category: NotificationCategory.SALES,
      title: 'BHPH payment due soon',
      body: this.bhphBody(e.borrowerName, e.vehicleTitle, e.dueDate ? `due ${e.dueDate}` : undefined),
      entity: { kind: 'loan', id: e.loanId },
      link: '/bhph',
      email: false,
    });
  }

  /** BHPH installment overdue → BHPH staff (in-app + staff email). */
  @OnEvent(NotificationEvent.BHPH_PAYMENT_OVERDUE, { async: true })
  async onBhphPaymentOverdue(e: BhphPaymentOverdueEvent): Promise<void> {
    await this.notifications.notify(this.bhphSpec(), {
      type: 'bhph.payment-overdue',
      category: NotificationCategory.SALES,
      title: 'BHPH payment overdue',
      body: this.bhphBody(e.borrowerName, e.vehicleTitle, e.daysLate ? `${e.daysLate} days overdue` : 'overdue'),
      entity: { kind: 'loan', id: e.loanId },
      link: '/bhph',
      email: true, // collections should get an email on overdue
    });
  }

  /** BHPH loan fully paid off → BHPH staff (in-app). */
  @OnEvent(NotificationEvent.BHPH_LOAN_PAID_OFF, { async: true })
  async onBhphLoanPaidOff(e: BhphLoanPaidOffEvent): Promise<void> {
    await this.notifications.notify(this.bhphSpec(), {
      type: 'bhph.loan-paid-off',
      category: NotificationCategory.SALES,
      title: 'BHPH loan paid off',
      body: this.bhphBody(e.borrowerName, e.vehicleTitle, 'fully paid'),
      entity: { kind: 'loan', id: e.loanId },
      link: '/bhph',
      email: false,
    });
  }
}
