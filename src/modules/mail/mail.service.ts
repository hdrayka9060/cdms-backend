import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { auth as googleAuth, gmail as googleGmail, type gmail_v1 } from '@googleapis/gmail';

/**
 * Thrown when `send({ throwOnFailure: true })` was requested AND the SMTP
 * transport rejected the message. Re-thrown to the calling service so the
 * domain operation (e.g. UsersService.invite) can roll back the row it just
 * created — we never want to leave an INVITED user in the DB if the email
 * carrying their token couldn't be delivered.
 */
export class MailDeliveryError extends ServiceUnavailableException {
  constructor(reason: string) {
    // 503 is the right shape for "the server tried but a dependency failed".
    // The message surfaces to the frontend toast verbatim.
    super(`Email could not be sent: ${reason}`);
  }
}

/**
 * Outbound email service. One concrete sender (SMTP via Nodemailer) used by:
 *   - UsersService.inviteUser  → sendInvite()
 *   - AuthService.forgotPassword → sendPasswordReset()
 *
 * Design notes:
 *  • **Never throws to the caller.** Mail is plumbing, not a domain action —
 *    if Gmail's SMTP is down, the invite endpoint must still create the user
 *    and return success. Failures are logged via `Logger.warn`.
 *  • **Dev fallback** — if `MAIL_HOST` is empty OR `MAIL_PASS` is the seeded
 *    placeholder ("your_app_password"), the link is printed to the backend
 *    console instead of dispatched over SMTP. Lets us test the invite flow
 *    locally without a real Gmail App Password.
 *  • Templates are simple HTML literals. Good enough for v1 per the docs'
 *    "template literals fine for v1" convention.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  /**
   * Which delivery path is active:
   *  • `gmail` — Gmail REST API over HTTPS (bypasses hosts that block SMTP,
   *    e.g. Render). Reuses the GOOGLE_* OAuth creds; token needs the
   *    `gmail.send` scope.
   *  • `smtp`  — classic Nodemailer SMTP.
   *  • `dev`   — no real creds; links are logged to console, never sent.
   */
  private transport: 'gmail' | 'smtp' | 'dev' = 'dev';
  private fromAddress = 'CDMS <noreply@cdms.com>';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // MAIL_FROM sometimes arrives wrapped in literal quotes (e.g. Render env
    // values like `"SpinAuto <x@gmail.com>"`) — strip them or the address
    // becomes a malformed From header.
    this.fromAddress = this.stripWrappingQuotes(
      this.config.get<string>('MAIL_FROM') ?? this.fromAddress,
    );

    // `MAIL_TRANSPORT` lets an operator force a path; otherwise we auto-select
    // Gmail-API (preferred — works where SMTP is blocked) → SMTP → dev.
    const forced = (this.config.get<string>('MAIL_TRANSPORT') ?? '').trim().toLowerCase();

    if (forced !== 'smtp' && this.initGmailApi()) return;
    if (forced !== 'gmail' && forced !== 'gmail-api' && this.initSmtp()) return;

    this.transport = 'dev';
    this.logger.warn(
      'No usable mail transport configured (Gmail-API needs GOOGLE_* creds with the ' +
        'gmail.send scope; SMTP needs MAIL_HOST/MAIL_USER/MAIL_PASS) — running in dev mode ' +
        '(links logged to console, not sent).',
    );
  }

  /**
   * Gmail REST API transport. Reuses the same OAuth2 creds as GoogleMeet
   * (single dealership Google account). Sends over HTTPS, so it works on hosts
   * that block outbound SMTP (Render). Returns true when active.
   */
  private initGmailApi(): boolean {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.config.get<string>('GOOGLE_REFRESH_TOKEN');

    const credsLookReal =
      !!clientId &&
      !!clientSecret &&
      !!refreshToken &&
      clientId !== 'your_google_client_id' &&
      clientSecret !== 'your_google_client_secret' &&
      refreshToken !== 'your_google_refresh_token';
    if (!credsLookReal) return false;

    try {
      const oauth2 = new googleAuth.OAuth2(clientId, clientSecret);
      oauth2.setCredentials({ refresh_token: refreshToken });
      this.gmail = googleGmail({ version: 'v1', auth: oauth2 });
      this.transport = 'gmail';

      // Non-blocking token check (mirrors GoogleMeet / SMTP.verify). Confirms
      // the refresh token is valid; a missing `gmail.send` scope only surfaces
      // on the first real send (getProfile would need a read scope we don't ask
      // for), so we call that out in the failure hint.
      oauth2.getAccessToken().then(
        () => this.logger.log(`📧 Gmail API transport ready (from=${this.fromAddress})`),
        (err) =>
          this.logger.warn(
            `📧 Gmail API token check failed — mail may not send: ${err?.message ?? err}. ` +
              'If this says invalid_grant, re-mint GOOGLE_REFRESH_TOKEN (with the gmail.send scope).',
          ),
      );
      return true;
    } catch (err) {
      this.gmail = null;
      this.logger.warn(
        `Gmail API init failed (${err instanceof Error ? err.message : err}) — trying SMTP next.`,
      );
      return false;
    }
  }

  /** Classic SMTP transport (Nodemailer). Returns true when active. */
  private initSmtp(): boolean {
    const host = this.config.get<string>('MAIL_HOST');
    const port = Number(this.config.get<string>('MAIL_PORT') ?? 587);
    const user = this.config.get<string>('MAIL_USER');
    const pass = this.config.get<string>('MAIL_PASS');
    const secure = String(this.config.get<string>('MAIL_SECURE') ?? 'false') === 'true';

    const credsLookReal =
      !!host && !!user && !!pass && pass !== 'your_app_password' && user !== 'your_email@gmail.com';
    if (!credsLookReal) return false;

    this.transport = 'smtp';
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      // Fail fast instead of hanging ~2 min when the host blocks the SMTP port.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });

    this.transporter.verify().then(
      () => this.logger.log(`📧 SMTP transport ready (${user}@${host}:${port})`),
      (err) => this.logger.warn(`📧 SMTP verify failed — invites may not deliver: ${err?.message ?? err}`),
    );
    return true;
  }

  private stripWrappingQuotes(v: string): string {
    const t = v.trim();
    return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1).trim()
      : t;
  }

  /**
   * Invite a new staff member. The `inviteUrl` is the absolute frontend link
   * (e.g. http://localhost:8080/accept-invite?token=<raw>) that the recipient
   * clicks to set a password and activate their account.
   *
   * **Throws** `MailDeliveryError` if the SMTP transport rejects the message
   * (only in real-mail mode — dev-mode never throws). The caller is expected
   * to roll back any user row it created when this throws.
   */
  async sendInvite(opts: {
    to: string;
    firstName: string;
    inviterName?: string;
    dealershipName?: string;
    roleName?: string;
    inviteUrl: string;
  }): Promise<void> {
    const subject = `You've been invited to ${opts.dealershipName ?? 'CDMS'}`;
    const html = renderInviteHtml(opts);
    const text = renderInviteText(opts);
    await this.send({
      to: opts.to,
      subject,
      html,
      text,
      contextTag: 'invite',
      throwOnFailure: true,
    });
  }

  /**
   * Password reset email. Called from AuthService.forgotPassword (previously
   * a no-op stub).
   */
  async sendPasswordReset(opts: {
    to: string;
    firstName?: string;
    resetUrl: string;
  }): Promise<void> {
    const subject = 'Reset your CDMS password';
    const html = renderPasswordResetHtml(opts);
    const text = renderPasswordResetText(opts);
    await this.send({ to: opts.to, subject, html, text, contextTag: 'password-reset' });
  }

  /**
   * Email a meeting's Google Meet link to its attendees. Used by
   * CalendarService when a virtual event auto-generates a link — we deliver
   * the link directly (best-effort) INSTEAD of sending Google Calendar
   * invites, per the dealer's preference. Multiple recipients are joined into
   * a single `To`.
   */
  async sendMeetingLink(opts: {
    to: string | string[];
    eventTitle: string;
    whenText: string;
    meetLink: string;
    organizerName?: string;
  }): Promise<void> {
    const to = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean).join(', ');
    if (!to || !opts.meetLink) return;
    const subject = `Meeting invite: ${opts.eventTitle}`;
    const html = renderMeetingHtml(opts);
    const text = renderMeetingText(opts);
    await this.send({ to, subject, html, text, contextTag: 'meeting-link' });
  }

  /**
   * Invite attendees to a calendar event (physical OR virtual). Sent on event
   * creation to the assignee + participants + customer. For virtual events we
   * include the meeting link (Google Meet or a pasted link); for physical
   * events we include the location. Best-effort — never breaks event creation.
   */
  async sendEventInvitation(opts: {
    to: string | string[];
    eventTitle: string;
    whenText: string;
    meetingType: 'physical' | 'virtual';
    location?: string;
    meetLink?: string;
    organizerName?: string;
  }): Promise<void> {
    const to = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean).join(', ');
    if (!to) return;
    const subject = `Invitation: ${opts.eventTitle}`;
    const html = renderEventInvitationHtml(opts);
    const text = renderEventInvitationText(opts);
    await this.send({ to, subject, html, text, contextTag: 'event-invite' });
  }

  /**
   * Notify attendees that an event changed — a new time and/or a switch
   * between physical and virtual. Called at most ONCE per update even when
   * several things changed (the caller collapses the changes into a single
   * `changesText`). Best-effort — never breaks the event update.
   */
  async sendEventUpdate(opts: {
    to: string | string[];
    eventTitle: string;
    whenText: string;
    changesText: string;
    meetingType: 'physical' | 'virtual';
    location?: string;
    meetLink?: string;
  }): Promise<void> {
    const to = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean).join(', ');
    if (!to) return;
    const subject = `Updated: ${opts.eventTitle}`;
    const html = renderEventUpdateHtml(opts);
    const text = renderEventUpdateText(opts);
    await this.send({ to, subject, html, text, contextTag: 'event-update' });
  }

  /**
   * Notify the dealership of a new Finance Application submitted on the public
   * website. Best-effort (never throws) — the visitor's submission must still
   * succeed even if the notification can't be delivered. `fields` is the full
   * set of captured form values (already label-friendly on the caller side is
   * NOT required — keys are humanised here).
   */
  async sendFinanceApplication(opts: {
    to: string;
    applicantName: string;
    applicantEmail: string;
    applicantPhone: string;
    vehicleOfInterest?: string;
    fields: Record<string, unknown>;
  }): Promise<void> {
    if (!opts.to) return;
    const subject = `New Finance Application — ${opts.applicantName || opts.applicantEmail}`;
    const html = renderFinanceApplicationHtml(opts);
    const text = renderFinanceApplicationText(opts);
    await this.send({ to: opts.to, subject, html, text, contextTag: 'finance-application' });
  }

  /**
   * Generic "new website inquiry" notification — sent to the dealership for
   * EVERY public form submission (service, contact, text-us-now, get-more-info,
   * car-finder, appointment, …). The Finance Application uses its own richer
   * template (sendFinanceApplication); every other form funnels through here.
   * Best-effort: the caller swallows failures so mail never blocks a submit.
   */
  async sendWebsiteInquiry(opts: {
    to: string;
    formLabel: string;
    name: string;
    email: string;
    phone: string;
    vehicleOfInterest?: string;
    message?: string;
    fields?: Record<string, unknown>;
  }): Promise<void> {
    if (!opts.to) return;
    const subject = `New ${opts.formLabel} — ${opts.name || opts.email}`;
    const html = renderWebsiteInquiryHtml(opts);
    const text = renderWebsiteInquiryText(opts);
    await this.send({ to: opts.to, subject, html, text, contextTag: 'website-inquiry' });
  }

  /**
   * Single send path.
   *
   * Default behaviour: swallow + warn (mail must never break a domain op).
   * With `throwOnFailure: true`: real-mode SMTP failures bubble as
   * `MailDeliveryError` so the caller can roll back. Dev mode (no real
   * creds configured) NEVER throws — it just logs the link and returns —
   * because dev mode means "I haven't set up SMTP yet, but I still want
   * the flow to work for testing".
   */
  private async send(opts: {
    to: string;
    subject: string;
    html: string;
    text: string;
    contextTag: string;
    throwOnFailure?: boolean;
  }): Promise<void> {
    if (this.transport === 'dev') {
      // Surface the full link in console so the developer can copy it into
      // the browser instead of waiting for SMTP. The tag makes it easy to
      // grep server logs for ("invite" or "password-reset").
      this.logger.warn(
        `[dev-mail/${opts.contextTag}] would send to=${opts.to} subject="${opts.subject}"\n${opts.text}`,
      );
      return;
    }

    try {
      const messageId =
        this.transport === 'gmail'
          ? await this.sendViaGmail(opts)
          : (
              await this.transporter!.sendMail({
                from: this.fromAddress,
                to: opts.to,
                subject: opts.subject,
                html: opts.html,
                text: opts.text,
              })
            ).messageId;
      this.logger.log(`📧 mail/${opts.contextTag} sent to=${opts.to} messageId=${messageId}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`📧 mail/${opts.contextTag} FAILED to=${opts.to}: ${reason}`);
      if (opts.throwOnFailure) {
        throw new MailDeliveryError(reason);
      }
      // Otherwise: swallow. Mail failure on a best-effort path (password
      // reset etc.) must never reject the originating request.
    }
  }

  /**
   * Build an RFC-822 MIME message (via Nodemailer's composer, so the same HTML
   * templates render identically) and hand it to the Gmail API's
   * `users.messages.send`. Sends as the authenticated dealership account.
   * Returns the Gmail message id.
   */
  private async sendViaGmail(opts: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<string> {
    if (!this.gmail) throw new Error('Gmail transport not initialised');

    const mime = await new MailComposer({
      from: this.fromAddress,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    })
      .compile()
      .build();

    const raw = mime
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return res.data.id ?? '(no-id)';
  }
}

// ── Templates ───────────────────────────────────────────────────────────────
// A single branded, table-based responsive shell wraps every email so they
// read as legitimate transactional mail (header wordmark, card body, footer
// with sender identity) rather than a lone coloured button on a white page.

const BRAND = 'CDMS';

/**
 * Wrap body HTML in the shared branded email shell. Table-based layout for
 * Outlook/Gmail compatibility; inline styles only (no <style> — many clients
 * strip it). `preheader` is the hidden inbox-preview snippet.
 */
function emailShell(opts: { title: string; preheader?: string; bodyHtml: string }): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f1f5f9;">${escapeHtml(opts.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:#0f172a;padding:20px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:18px;font-weight:700;letter-spacing:.4px;color:#ffffff;">
            <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;background:#2563eb;border-radius:7px;color:#ffffff;font-size:13px;margin-right:10px;vertical-align:middle;">◆</span>${BRAND}
          </td>
          <td align="right" style="font-size:12px;color:#94a3b8;">Dealer Management</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:32px;color:#0f172a;font-size:15px;line-height:1.6;">${opts.bodyHtml}</td></tr>
      <tr><td style="padding:18px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.5;">
        This is an automated message from ${BRAND}. Please do not reply to this email.<br>
        &copy; ${year} ${BRAND} · Dealer Management System
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** A bulletproof-ish CTA button (table-cell background for Outlook). */
function emailButton(href: string, label: string, color = '#2563eb'): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
    <td style="border-radius:8px;background:${color};">
      <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
    </td></tr></table>`;
}

/** A light details panel of label/value rows. Values are pre-escaped HTML. */
function infoPanel(rows: [string, string][]): string {
  const trs = rows
    .map(
      ([label, value]) => `<tr>
        <td style="padding:5px 0;font-size:13px;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top;width:64px;">${escapeHtml(label)}</td>
        <td style="padding:5px 0 5px 16px;font-size:14px;color:#0f172a;">${value}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;">
    <tr><td style="padding:14px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${trs}</table></td></tr>
  </table>`;
}

/** A small uppercase eyebrow label above the heading. */
function eyebrow(text: string, color = '#2563eb'): string {
  return `<p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${color};">${escapeHtml(text)}</p>`;
}

/** A "or open this link" fallback line for a button. */
function linkFallback(url: string, lead = 'Or open this link:'): string {
  return `<p style="font-size:13px;color:#64748b;margin:4px 0 0;">${escapeHtml(lead)}<br><a href="${url}" style="color:#2563eb;word-break:break-all;">${url}</a></p>`;
}

function renderInviteHtml(opts: {
  firstName: string;
  inviterName?: string;
  dealershipName?: string;
  roleName?: string;
  inviteUrl: string;
}): string {
  const dealership = opts.dealershipName ?? 'CDMS';
  const inviter = opts.inviterName ?? 'Your administrator';
  const role = opts.roleName ? ` as <strong>${escapeHtml(opts.roleName)}</strong>` : '';
  const body = `
    ${eyebrow("You're invited")}
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a;">Join ${escapeHtml(dealership)}</h1>
    <p style="margin:0 0 12px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="margin:0 0 4px;color:#475569;">${escapeHtml(inviter)} has invited you to join <strong>${escapeHtml(dealership)}</strong>${role} on ${BRAND}. Set your password to activate your account.</p>
    ${emailButton(opts.inviteUrl, 'Accept invitation')}
    ${linkFallback(opts.inviteUrl, 'Or copy this link into your browser:')}
    <p style="font-size:13px;color:#94a3b8;margin:20px 0 0;">This invitation expires in 7 days. If you weren't expecting it, you can safely ignore this email.</p>
  `;
  return emailShell({
    title: `You've been invited to ${dealership}`,
    preheader: `Set your password to join ${dealership} on ${BRAND}.`,
    bodyHtml: body,
  });
}

function renderInviteText(opts: {
  firstName: string;
  inviterName?: string;
  dealershipName?: string;
  roleName?: string;
  inviteUrl: string;
}): string {
  const dealership = opts.dealershipName ?? 'CDMS';
  const inviter = opts.inviterName ?? 'Your administrator';
  const role = opts.roleName ? ` as ${opts.roleName}` : '';
  return [
    `Hi ${opts.firstName},`,
    ``,
    `${inviter} has invited you to join ${dealership}${role} on CDMS.`,
    ``,
    `Set your password and log in:`,
    opts.inviteUrl,
    ``,
    `This invitation expires in 7 days.`,
  ].join('\n');
}

function renderPasswordResetHtml(opts: { firstName?: string; resetUrl: string }): string {
  const name = opts.firstName ?? 'there';
  const body = `
    ${eyebrow('Password reset')}
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a;">Reset your password</h1>
    <p style="margin:0 0 12px;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 4px;color:#475569;">We received a request to reset your ${BRAND} password. Choose a new one below.</p>
    ${emailButton(opts.resetUrl, 'Reset password')}
    ${linkFallback(opts.resetUrl)}
    <p style="font-size:13px;color:#94a3b8;margin:20px 0 0;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `;
  return emailShell({
    title: `Reset your ${BRAND} password`,
    preheader: `Choose a new password for your ${BRAND} account.`,
    bodyHtml: body,
  });
}

function renderPasswordResetText(opts: { firstName?: string; resetUrl: string }): string {
  return [
    `Hi ${opts.firstName ?? 'there'},`,
    ``,
    `Reset your CDMS password:`,
    opts.resetUrl,
    ``,
    `This link expires in 1 hour.`,
  ].join('\n');
}

function renderMeetingHtml(opts: {
  eventTitle: string;
  whenText: string;
  meetLink: string;
  organizerName?: string;
}): string {
  const organizer = opts.organizerName
    ? `${escapeHtml(opts.organizerName)} has invited you to a meeting.`
    : `You've been invited to a meeting.`;
  const body = `
    ${eyebrow('Meeting invitation')}
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">${escapeHtml(opts.eventTitle)}</h1>
    <p style="margin:0 0 18px;color:#475569;">${organizer}</p>
    ${infoPanel([
      ['When', escapeHtml(opts.whenText)],
      ['Where', 'Online video meeting'],
    ])}
    ${emailButton(opts.meetLink, 'Join the meeting')}
    ${linkFallback(opts.meetLink)}
  `;
  return emailShell({
    title: `Meeting invite: ${opts.eventTitle}`,
    preheader: `${opts.eventTitle} · ${opts.whenText}`,
    bodyHtml: body,
  });
}

function renderMeetingText(opts: {
  eventTitle: string;
  whenText: string;
  meetLink: string;
  organizerName?: string;
}): string {
  return [
    opts.eventTitle,
    ``,
    opts.organizerName ? `${opts.organizerName} has invited you to a meeting.` : `You've been invited to a meeting.`,
    ``,
    `When: ${opts.whenText}`,
    ``,
    `Join with Google Meet:`,
    opts.meetLink,
  ].join('\n');
}

// ── Calendar event templates ─────────────────────────────────────────────

/**
 * The "Where" value + optional Join CTA/link shared by the event invitation
 * and update HTML templates.
 */
function eventVenue(opts: { meetingType: 'physical' | 'virtual'; location?: string; meetLink?: string }): {
  whereValue: string;
  ctaHtml: string;
} {
  if (opts.meetingType === 'virtual') {
    if (opts.meetLink) {
      return {
        whereValue: 'Online video meeting',
        ctaHtml: `${emailButton(opts.meetLink, 'Join the meeting')}${linkFallback(opts.meetLink)}`,
      };
    }
    return { whereValue: 'Online — the meeting link will follow', ctaHtml: '' };
  }
  return { whereValue: escapeHtml(opts.location || 'Location to be confirmed'), ctaHtml: '' };
}

/** Location/link line shared by the invitation + update templates (text). */
function eventWhereText(opts: { meetingType: 'physical' | 'virtual'; location?: string; meetLink?: string }): string {
  if (opts.meetingType === 'virtual') {
    return opts.meetLink ? `Join: ${opts.meetLink}` : 'Where: Virtual — the meeting link will follow.';
  }
  return `Where: ${opts.location || 'Location to be confirmed'}`;
}

function renderEventInvitationHtml(opts: {
  eventTitle: string;
  whenText: string;
  meetingType: 'physical' | 'virtual';
  location?: string;
  meetLink?: string;
  organizerName?: string;
}): string {
  const organizer = opts.organizerName
    ? `${escapeHtml(opts.organizerName)} has invited you to an event.`
    : `You've been invited to an event.`;
  const venue = eventVenue(opts);
  const body = `
    ${eyebrow('Event invitation')}
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">${escapeHtml(opts.eventTitle)}</h1>
    <p style="margin:0 0 18px;color:#475569;">${organizer}</p>
    ${infoPanel([
      ['When', escapeHtml(opts.whenText)],
      ['Where', venue.whereValue],
    ])}
    ${venue.ctaHtml}
  `;
  return emailShell({
    title: `Invitation: ${opts.eventTitle}`,
    preheader: `${opts.eventTitle} · ${opts.whenText}`,
    bodyHtml: body,
  });
}

function renderEventInvitationText(opts: {
  eventTitle: string;
  whenText: string;
  meetingType: 'physical' | 'virtual';
  location?: string;
  meetLink?: string;
  organizerName?: string;
}): string {
  return [
    opts.eventTitle,
    ``,
    opts.organizerName ? `${opts.organizerName} has invited you to an event.` : `You've been invited to an event.`,
    ``,
    `When: ${opts.whenText}`,
    eventWhereText(opts),
  ].join('\n');
}

function renderEventUpdateHtml(opts: {
  eventTitle: string;
  whenText: string;
  changesText: string;
  meetingType: 'physical' | 'virtual';
  location?: string;
  meetLink?: string;
}): string {
  const venue = eventVenue(opts);
  const body = `
    ${eyebrow('Event updated', '#d97706')}
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0f172a;">${escapeHtml(opts.eventTitle)}</h1>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin:0 0 4px;">
      <tr><td style="padding:12px 16px;color:#92400e;font-size:14px;line-height:1.5;">${escapeHtml(opts.changesText)}</td></tr>
    </table>
    ${infoPanel([
      ['When', escapeHtml(opts.whenText)],
      ['Where', venue.whereValue],
    ])}
    ${venue.ctaHtml}
  `;
  return emailShell({
    title: `Updated: ${opts.eventTitle}`,
    preheader: `${opts.eventTitle} was updated · ${opts.whenText}`,
    bodyHtml: body,
  });
}

function renderEventUpdateText(opts: {
  eventTitle: string;
  whenText: string;
  changesText: string;
  meetingType: 'physical' | 'virtual';
  location?: string;
  meetLink?: string;
}): string {
  return [
    `${opts.eventTitle} — updated`,
    ``,
    opts.changesText,
    ``,
    `When: ${opts.whenText}`,
    eventWhereText(opts),
  ].join('\n');
}

// Human-readable label for a camelCase form field key. A few keys get explicit
// overrides; the rest are de-camelCased ("employmentPhone" → "Employment Phone").
function humanizeFieldKey(k: string): string {
  const overrides: Record<string, string> = {
    sin: 'SIN (Social Insurance Number)',
    vehicleOfInterest: 'Vehicle Of Interest',
    preferredContact: 'Preferred Contact',
  };
  if (overrides[k]) return overrides[k];
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** Ordered [label, value] rows for a finance application: contact → vehicle → all other fields. */
function financeApplicationRows(opts: {
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  vehicleOfInterest?: string;
  fields: Record<string, unknown>;
}): [string, string][] {
  const rows: [string, string][] = [
    ['Name', opts.applicantName],
    ['Email', opts.applicantEmail],
    ['Phone', opts.applicantPhone],
  ];
  if (opts.vehicleOfInterest) rows.push(['Vehicle Of Interest', opts.vehicleOfInterest]);
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    if (k === 'vehicleOfInterest') continue; // already shown above
    if (v === undefined || v === null || String(v).trim() === '') continue;
    rows.push([humanizeFieldKey(k), Array.isArray(v) ? v.join(', ') : String(v)]);
  }
  return rows.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
}

function renderFinanceApplicationHtml(opts: {
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  vehicleOfInterest?: string;
  fields: Record<string, unknown>;
}): string {
  const rows = financeApplicationRows(opts)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 14px;border:1px solid #e2e8f0;color:#64748b;white-space:nowrap;vertical-align:top;font-weight:600;font-size:13px;">${escapeHtml(label)}</td><td style="padding:9px 14px;border:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const body = `
    ${eyebrow('New submission')}
    <h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#0f172a;">New Finance Application</h1>
    <p style="margin:0 0 16px;color:#475569;">Submitted via the website finance application form.</p>
    <table role="presentation" style="border-collapse:collapse;width:100%;">${rows}</table>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;">This application contains sensitive personal information — handle it per your privacy policy.</p>
  `;
  return emailShell({
    title: `New Finance Application — ${opts.applicantName || opts.applicantEmail}`,
    preheader: `New finance application from ${opts.applicantName || opts.applicantEmail}.`,
    bodyHtml: body,
  });
}

function renderFinanceApplicationText(opts: {
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  vehicleOfInterest?: string;
  fields: Record<string, unknown>;
}): string {
  const lines = ['New Finance Application — submitted via website', ''];
  for (const [label, value] of financeApplicationRows(opts)) {
    lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}

/** Ordered [label, value] rows for a generic website inquiry: contact → vehicle → message → other fields. */
function websiteInquiryRows(opts: {
  name: string;
  email: string;
  phone: string;
  vehicleOfInterest?: string;
  message?: string;
  fields?: Record<string, unknown>;
}): [string, string][] {
  const rows: [string, string][] = [
    ['Name', opts.name],
    ['Email', opts.email],
    ['Phone', opts.phone],
  ];
  if (opts.vehicleOfInterest) rows.push(['Vehicle Of Interest', opts.vehicleOfInterest]);
  if (opts.message && opts.message.trim()) rows.push(['Message', opts.message.trim()]);
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    if (k === 'vehicleOfInterest') continue; // already shown above
    if (v === undefined || v === null || String(v).trim() === '') continue;
    rows.push([humanizeFieldKey(k), Array.isArray(v) ? v.join(', ') : String(v)]);
  }
  return rows.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
}

function renderWebsiteInquiryHtml(opts: {
  formLabel: string;
  name: string;
  email: string;
  phone: string;
  vehicleOfInterest?: string;
  message?: string;
  fields?: Record<string, unknown>;
}): string {
  const rows = websiteInquiryRows(opts)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 14px;border:1px solid #e2e8f0;color:#64748b;white-space:nowrap;vertical-align:top;font-weight:600;font-size:13px;">${escapeHtml(label)}</td><td style="padding:9px 14px;border:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const body = `
    ${eyebrow('New submission')}
    <h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#0f172a;">New ${escapeHtml(opts.formLabel)}</h1>
    <p style="margin:0 0 16px;color:#475569;">Submitted via the website ${escapeHtml(opts.formLabel.toLowerCase())} form.</p>
    <table role="presentation" style="border-collapse:collapse;width:100%;">${rows}</table>
  `;
  return emailShell({
    title: `New ${opts.formLabel} — ${opts.name || opts.email}`,
    preheader: `New ${opts.formLabel.toLowerCase()} from ${opts.name || opts.email}.`,
    bodyHtml: body,
  });
}

function renderWebsiteInquiryText(opts: {
  formLabel: string;
  name: string;
  email: string;
  phone: string;
  vehicleOfInterest?: string;
  message?: string;
  fields?: Record<string, unknown>;
}): string {
  const lines = [`New ${opts.formLabel} — submitted via website`, ''];
  for (const [label, value] of websiteInquiryRows(opts)) {
    lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
