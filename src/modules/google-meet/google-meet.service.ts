import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  auth as googleAuth,
  calendar as googleCalendar,
  calendar_v3,
} from '@googleapis/calendar';

export interface MeetEventInput {
  title: string;
  description?: string;
  /** RFC3339 / ISO instants (with 'Z' or offset). The browser already did
   *  local→UTC, so toISOString() values are correct here. */
  startISO: string;
  endISO: string;
}

export interface MeetEventResult {
  meetLink: string;
  googleEventId: string;
}

/**
 * Creates REAL Google Meet links by inserting a Google Calendar event with a
 * `conferenceData.createRequest`. Google returns a genuine `meet.google.com`
 * room (`hangoutLink`) bound to the scheduled event — unlike the previous
 * mock generator, which stitched random characters into the Meet URL format
 * and produced a dead link ("Check your meeting code").
 *
 * Auth model: a SINGLE dealership Google account via a stored OAuth2 refresh
 * token in `.env` — consistent with single-tenant ("one dealership = one
 * deployment") and mirrors how MailService uses one SMTP account.
 *
 * Design notes (mirrors MailService):
 *  • **Never throws to the caller.** Meet provisioning is plumbing — if the
 *    Google API is down, the calendar event must still save (just without a
 *    link). Failures are logged via `Logger.warn`; create/update return null.
 *  • **Dev fallback** — if the OAuth creds are empty or still the seeded
 *    placeholders, the service runs in dev mode: it provisions NOTHING and
 *    returns null. Virtual events simply have no auto-link until creds are
 *    configured (the user can still paste their own link). This is the whole
 *    point of the rewrite — no more misleading dead links in any mode.
 */
@Injectable()
export class GoogleMeetService implements OnModuleInit {
  private readonly logger = new Logger(GoogleMeetService.name);
  private calendar: calendar_v3.Calendar | null = null;
  private calendarId = 'primary';
  private devMode = true;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.config.get<string>('GOOGLE_REFRESH_TOKEN');
    this.calendarId = this.config.get<string>('GOOGLE_CALENDAR_ID') || 'primary';

    // Treat unset / placeholder creds as dev mode. `.env` ships obvious
    // placeholders so a fresh checkout doesn't try (and fail) to reach
    // Google.
    const credsLookReal =
      !!clientId &&
      !!clientSecret &&
      !!refreshToken &&
      clientId !== 'your_google_client_id' &&
      clientSecret !== 'your_google_client_secret' &&
      refreshToken !== 'your_google_refresh_token';

    if (!credsLookReal) {
      this.devMode = true;
      this.logger.warn(
        'GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not fully configured — Google Meet running in dev mode (no link generated; paste-your-own still works).',
      );
      return;
    }

    this.devMode = false;
    const oauth2 = new googleAuth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    this.calendar = googleCalendar({ version: 'v3', auth: oauth2 });

    // Confirm the refresh token actually works so a bad token surfaces at
    // boot rather than on the first virtual event. Non-blocking, like
    // MailService's transporter.verify().
    oauth2.getAccessToken().then(
      () => this.logger.log(`🎥 Google Meet ready (calendarId=${this.calendarId})`),
      (err) =>
        this.logger.warn(
          `🎥 Google Meet token check failed — Meet links may not generate: ${err?.message ?? err}`,
        ),
    );
  }

  /** Whether real Meet provisioning is active (creds configured). */
  isEnabled(): boolean {
    return !this.devMode && !!this.calendar;
  }

  /**
   * Create a Google Calendar event with a Meet conference. Returns the real
   * link + the Google event id (stored so we can patch/cancel it later), or
   * null in dev mode / on failure.
   */
  async createMeetEvent(input: MeetEventInput): Promise<MeetEventResult | null> {
    if (this.devMode || !this.calendar) {
      this.logger.warn(
        `[dev-meet] would create Meet for "${input.title}" (${input.startISO}) — skipped (dev mode).`,
      );
      return null;
    }
    try {
      const res = await this.calendar.events.insert({
        calendarId: this.calendarId,
        conferenceDataVersion: 1,
        // sendUpdates: 'none' + no attendees → the event exists ONLY on the
        // dealership account's own calendar purely to mint the Meet room. No
        // Google Calendar invites are sent to anyone; CalendarService emails
        // the link to attendees itself.
        sendUpdates: 'none',
        requestBody: this.buildRequestBody(input, true),
      });
      const result = this.extractResult(res.data);
      if (!result) {
        this.logger.warn(`🎥 Meet created but no link returned for "${input.title}"`);
        return null;
      }
      this.logger.log(`🎥 Meet created eventId=${result.googleEventId} link=${result.meetLink}`);
      return result;
    } catch (err) {
      this.logger.warn(`🎥 Meet create FAILED for "${input.title}": ${reason(err)}`);
      return null;
    }
  }

  /**
   * Patch an existing Google event (keep its Meet link in sync after a CDMS
   * edit). When `regenerateLink` is true a fresh conference is provisioned
   * (used when the user re-ticks "Create Google Meet link" on edit).
   */
  async updateMeetEvent(
    googleEventId: string,
    input: MeetEventInput & { regenerateLink?: boolean },
  ): Promise<MeetEventResult | null> {
    if (this.devMode || !this.calendar || !googleEventId) return null;
    try {
      const res = await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId: googleEventId,
        conferenceDataVersion: input.regenerateLink ? 1 : 0,
        sendUpdates: 'none',
        requestBody: this.buildRequestBody(input, input.regenerateLink === true),
      });
      return this.extractResult(res.data);
    } catch (err) {
      this.logger.warn(`🎥 Meet patch FAILED eventId=${googleEventId}: ${reason(err)}`);
      return null;
    }
  }

  /** Cancel the Google event so no orphan Meet room lingers on the dealer's calendar. */
  async deleteMeetEvent(googleEventId: string): Promise<void> {
    if (this.devMode || !this.calendar || !googleEventId) return;
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId: googleEventId,
        sendUpdates: 'none',
      });
      this.logger.log(`🎥 Meet event cancelled eventId=${googleEventId}`);
    } catch (err) {
      // 404/410 = already gone; anything else is logged but non-fatal.
      this.logger.warn(`🎥 Meet delete FAILED eventId=${googleEventId}: ${reason(err)}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private buildRequestBody(
    input: MeetEventInput,
    withConference: boolean,
  ): calendar_v3.Schema$Event {
    // No `attendees` — we deliberately don't invite anyone via Google Calendar.
    // CalendarService emails the Meet link to attendees instead.
    const body: calendar_v3.Schema$Event = {
      summary: input.title,
      description: input.description || undefined,
      start: { dateTime: input.startISO },
      end: { dateTime: input.endISO },
    };
    if (withConference) {
      body.conferenceData = {
        createRequest: {
          // Idempotency key — a unique id per provisioning request.
          requestId: randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }
    return body;
  }

  private extractResult(data: calendar_v3.Schema$Event): MeetEventResult | null {
    const meetLink =
      data.hangoutLink ||
      data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ||
      '';
    if (!data.id) return null;
    return { meetLink, googleEventId: data.id };
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
