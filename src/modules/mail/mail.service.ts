import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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
  private fromAddress = 'CDMS <noreply@cdms.com>';
  private devMode = true;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get<string>('MAIL_HOST');
    const port = Number(this.config.get<string>('MAIL_PORT') ?? 587);
    const user = this.config.get<string>('MAIL_USER');
    const pass = this.config.get<string>('MAIL_PASS');
    const secure = String(this.config.get<string>('MAIL_SECURE') ?? 'false') === 'true';
    this.fromAddress = this.config.get<string>('MAIL_FROM') ?? this.fromAddress;

    // Treat unset / placeholder creds as "dev mode". The .env.example ships
    // with `your_app_password` as the default which is obviously not real.
    const credsLookReal =
      !!host && !!user && !!pass && pass !== 'your_app_password' && user !== 'your_email@gmail.com';

    if (!credsLookReal) {
      this.devMode = true;
      this.logger.warn(
        `MAIL_HOST/MAIL_USER/MAIL_PASS not fully configured — running in dev mode (links logged to console, not sent).`,
      );
      return;
    }

    this.devMode = false;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    // Verify the connection at boot so misconfigurations surface immediately
    // rather than on the first invite attempt. `verify` returns a promise but
    // we don't block boot on it.
    this.transporter.verify().then(
      () => this.logger.log(`📧 SMTP transport ready (${user}@${host}:${port})`),
      (err) => this.logger.warn(`📧 SMTP verify failed — invites may not deliver: ${err?.message ?? err}`),
    );
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
    if (this.devMode || !this.transporter) {
      // Surface the full link in console so the developer can copy it into
      // the browser instead of waiting for SMTP. The tag makes it easy to
      // grep server logs for ("invite" or "password-reset").
      this.logger.warn(
        `[dev-mail/${opts.contextTag}] would send to=${opts.to} subject="${opts.subject}"\n${opts.text}`,
      );
      return;
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      this.logger.log(`📧 mail/${opts.contextTag} sent to=${opts.to} messageId=${info.messageId}`);
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
}

// ── Templates ───────────────────────────────────────────────────────────────
// Plain template literals. Branding can be upgraded later; the goal here is a
// readable, click-through-able message that doesn't get caught in spam.

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
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827; margin-bottom: 8px;">You've been invited</h2>
  <p>Hi ${escapeHtml(opts.firstName)},</p>
  <p>${escapeHtml(inviter)} has invited you to join <strong>${escapeHtml(dealership)}</strong>${role} on CDMS — a complete dealership management platform.</p>
  <p>Click the button below to set your password and log in:</p>
  <p style="margin: 24px 0;">
    <a href="${opts.inviteUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Accept invitation</a>
  </p>
  <p style="font-size: 13px; color: #6b7280;">Or copy this link into your browser:<br><a href="${opts.inviteUrl}">${opts.inviteUrl}</a></p>
  <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">This invitation expires in 7 days. If you weren't expecting this, you can ignore the email.</p>
</body></html>`;
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
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <h2 style="color: #111827; margin-bottom: 8px;">Reset your password</h2>
  <p>Hi ${escapeHtml(name)},</p>
  <p>We received a request to reset your CDMS password. Click the button below to choose a new one:</p>
  <p style="margin: 24px 0;">
    <a href="${opts.resetUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset password</a>
  </p>
  <p style="font-size: 13px; color: #6b7280;">Or copy this link:<br><a href="${opts.resetUrl}">${opts.resetUrl}</a></p>
  <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">This link expires in 1 hour. If you didn't request this, you can safely ignore the email.</p>
</body></html>`;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
