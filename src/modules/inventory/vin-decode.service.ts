import {
  Injectable, Logger, BadRequestException, ServiceUnavailableException,
} from '@nestjs/common';
import { FuelType, Transmission } from './schemas/vehicle.schema';

/**
 * Server-side VIN decoder backed by the free NHTSA vPIC API.
 *
 * Why server-side (and not the old in-browser fetch): it lets bulk upload decode
 * up to 50 VINs per request via NHTSA's batch endpoint, gives us one place to
 * map NHTSA's 130-field response onto our vehicle shape (shared by the single
 * lookup AND bulk), and keeps the door open to swap in a paid Canadian provider
 * later without touching the controller or frontend. NHTSA is keyless, so there
 * is no secret to manage.
 *
 * NHTSA decodes any US/Canada-market VIN (the VIN is an ISO-3779 global standard;
 * the WMI just encodes country of origin), so this works for Canadian vehicles
 * out of the box.
 */

/** Display-ready decode result for the single-VIN Add-Vehicle form auto-fill. */
export interface DecodedVin {
  vin: string;
  make?: string; // title-cased ("Nissan")
  model?: string;
  modelYear?: number;
  trim?: string;
  engine?: string; // "2.5L · 4-cyl · 170hp"
  fuel?: string; // raw NHTSA FuelTypePrimary, e.g. "Gasoline" (the form mapper coerces on save)
  transmission?: string; // composed raw, e.g. "Automatic 8-spd"
  bodyType?: string; // normalized to our canonical dropdown list ("SUV")
  plant?: string; // "Smyrna, Tennessee, United States (USA)"
  country?: string; // PlantCountry — country of origin
  title?: string; // "2016 Nissan Rogue"
}

/** Vehicle-create-shaped fields used by bulk upload (fuel/transmission coerced to schema enums). */
export interface DecodedVehicleFields {
  company?: string;
  model?: string;
  year?: number;
  trim?: string;
  engine?: string;
  bodyType?: string;
  fuelType?: FuelType;
  transmission?: Transmission;
  title?: string;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

@Injectable()
export class VinDecodeService {
  private readonly logger = new Logger(VinDecodeService.name);
  private readonly BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
  /**
   * NHTSA documents a hard cap of 50 VINs per DecodeVINValuesBatch request.
   * Kept as a single knob so we can dial it down if live responses ever prove
   * flaky — the chunking below handles any N regardless of this value.
   */
  private readonly BATCH_SIZE = 50;
  private readonly TIMEOUT_MS = 20_000;

  isValidVin(vin?: string): boolean {
    return VIN_RE.test((vin ?? '').trim());
  }

  /**
   * Decode a single VIN for the Add-Vehicle form auto-fill.
   * Throws 400 on an invalid/undecodable VIN, 503 if NHTSA is unreachable.
   */
  async decodeOne(vin: string, year?: number): Promise<DecodedVin> {
    const v = (vin ?? '').trim().toUpperCase();
    if (!this.isValidVin(v)) {
      throw new BadRequestException('VIN must be 17 characters (letters & digits, excluding I, O, Q).');
    }
    const url = `${this.BASE}/DecodeVinValues/${encodeURIComponent(v)}?format=json${year ? `&modelyear=${year}` : ''}`;
    let json: any;
    try {
      json = await this.fetchJson(url);
    } catch (err: any) {
      this.logger.warn(`VIN decode failed for ${v}: ${err?.message}`);
      throw new ServiceUnavailableException('VIN lookup service is currently unavailable. Please try again.');
    }
    const r = json?.Results?.[0];
    if (!r) throw new ServiceUnavailableException('No data returned for this VIN.');
    if (!this.errorCodeAcceptable(r.ErrorCode)) {
      throw new BadRequestException(r.ErrorText || 'This VIN could not be decoded.');
    }
    const decoded = this.toDecodedVin(v, r);
    if (!decoded.make && !decoded.model && !decoded.modelYear) {
      throw new BadRequestException('VIN is valid but no vehicle data is available.');
    }
    return decoded;
  }

  /**
   * Decode many VINs via NHTSA's batch endpoint, chunked by BATCH_SIZE and
   * called sequentially (NHTSA rate-limits aggressive parallel traffic).
   *
   * Best-effort: a failed/timed-out chunk simply yields no entries for its VINs
   * — the caller (bulk upload) falls back to the CSV values for those rows and
   * never 500s the whole upload. Returns a map keyed by upper-cased VIN.
   */
  async decodeBatch(items: { vin: string; year?: number }[]): Promise<Map<string, DecodedVehicleFields>> {
    const out = new Map<string, DecodedVehicleFields>();

    // Keep only well-formed VINs, upper-cased and de-duplicated.
    const seen = new Set<string>();
    const unique: { vin: string; year?: number }[] = [];
    for (const it of items) {
      if (!this.isValidVin(it.vin)) continue;
      const v = it.vin.trim().toUpperCase();
      if (seen.has(v)) continue;
      seen.add(v);
      unique.push({ vin: v, year: it.year });
    }

    for (let i = 0; i < unique.length; i += this.BATCH_SIZE) {
      const chunk = unique.slice(i, i + this.BATCH_SIZE);
      const data = chunk.map((c) => (c.year ? `${c.vin},${c.year}` : c.vin)).join(';');
      try {
        const json = await this.fetchJson(`${this.BASE}/DecodeVINValuesBatch/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ format: 'json', data }).toString(),
        });
        for (const r of json?.Results ?? []) {
          const vin = String(r.VIN || '').trim().toUpperCase();
          if (!vin || !this.errorCodeAcceptable(r.ErrorCode)) continue;
          const fields = this.toDecodedVehicleFields(r);
          if (fields.company || fields.model || fields.year) out.set(vin, fields);
        }
      } catch (err: any) {
        this.logger.warn(
          `VIN batch chunk ${Math.floor(i / this.BATCH_SIZE) + 1} (${chunk.length} VIN[s]) failed: ${err?.message}. Those rows fall back to CSV values.`,
        );
      }
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) throw new Error(`NHTSA responded ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** NHTSA ErrorCode is a comma-joined list; "0" = clean, "1"/"6" = partial-but-usable. */
  private errorCodeAcceptable(code: any): boolean {
    if (code === undefined || code === null || code === '') return true;
    const first = String(code).split(',')[0].trim();
    return ['0', '1', '6'].includes(first);
  }

  private toDecodedVin(vin: string, r: any): DecodedVin {
    const make = (r.Make || '').trim();
    const model = (r.Model || '').trim();
    const yearNum = r.ModelYear ? parseInt(r.ModelYear, 10) : undefined;
    const company = make ? this.toTitle(make) : undefined;
    const trim = (r.Trim || r.Series || '').trim() || undefined;
    const country = (r.PlantCountry || '').trim() || undefined;
    const plant =
      [r.PlantCity, r.PlantState, r.PlantCountry].map((x) => (x || '').trim()).filter(Boolean).join(', ') || undefined;
    return {
      vin,
      make: company,
      model: model || undefined,
      modelYear: Number.isFinite(yearNum) ? yearNum : undefined,
      trim,
      engine: this.composeEngine(r) || undefined,
      fuel: (r.FuelTypePrimary || '').trim() || undefined,
      transmission: this.composeTransmission(r) || undefined,
      bodyType: this.normalizeBodyType(r.BodyClass),
      plant,
      country,
      title: [yearNum, company, model, (r.Trim || '').trim()].filter(Boolean).join(' ') || undefined,
    };
  }

  private toDecodedVehicleFields(r: any): DecodedVehicleFields {
    const make = (r.Make || '').trim();
    const model = (r.Model || '').trim();
    const yearNum = r.ModelYear ? parseInt(r.ModelYear, 10) : undefined;
    const company = make ? this.toTitle(make) : undefined;
    return {
      company,
      model: model || undefined,
      year: Number.isFinite(yearNum) ? yearNum : undefined,
      trim: (r.Trim || r.Series || '').trim() || undefined,
      engine: this.composeEngine(r) || undefined,
      bodyType: this.normalizeBodyType(r.BodyClass),
      fuelType: this.normalizeFuel(r.FuelTypePrimary),
      transmission: this.normalizeTransmission(r.TransmissionStyle),
      title: [yearNum, company, model, (r.Trim || '').trim()].filter(Boolean).join(' ') || undefined,
    };
  }

  private composeEngine(r: any): string {
    return [
      r.DisplacementL && `${parseFloat(r.DisplacementL).toFixed(1)}L`,
      r.EngineCylinders && `${r.EngineCylinders}-cyl`,
      r.EngineHP && `${r.EngineHP}hp`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private composeTransmission(r: any): string {
    return [r.TransmissionStyle, r.TransmissionSpeeds && `${r.TransmissionSpeeds}-spd`]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private toTitle(s: string): string {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ── Normalizers (mirror frontend src/lib/vehicle-mapper.ts so single + bulk agree) ──

  /** Squash NHTSA's free-text BodyClass onto our canonical 12-option dropdown list. */
  private normalizeBodyType(raw?: string): string | undefined {
    if (!raw) return undefined;
    const s = raw.toLowerCase();
    if (s.includes('pickup')) return 'Pickup';
    if (s.includes('truck')) return 'Truck';
    if (s.includes('sedan') || s.includes('saloon')) return 'Sedan';
    if (s.includes('suv') || s.includes('sport utility')) return 'SUV';
    if (s.includes('coupe')) return 'Coupe';
    if (s.includes('hatchback') || s.includes('hatch')) return 'Hatchback';
    if (s.includes('convertible') || s.includes('roadster') || s.includes('cabriolet')) return 'Convertible';
    if (s.includes('wagon') || s.includes('estate')) return 'Wagon';
    if (s.includes('minivan') || s.includes('mpv')) return 'Minivan';
    if (s.includes('crossover') || s.includes('cuv')) return 'Crossover';
    if (s.includes('van')) return 'Van';
    return 'Other';
  }

  private normalizeFuel(raw?: string): FuelType | undefined {
    if (!raw) return undefined;
    const s = raw.toLowerCase();
    if (s.includes('electric') && !s.includes('hybrid')) return FuelType.ELECTRIC;
    if (s.includes('hybrid')) return FuelType.HYBRID;
    if (s.includes('diesel')) return FuelType.DIESEL;
    if (s.includes('cng') || s.includes('compressed natural')) return FuelType.CNG;
    if (s.includes('gas') || s.includes('petrol')) return FuelType.PETROL;
    return undefined;
  }

  private normalizeTransmission(raw?: string): Transmission | undefined {
    if (!raw) return undefined;
    const s = raw.toLowerCase();
    if (s.includes('cvt') || s.includes('continuously variable')) return Transmission.CVT;
    if (s.includes('manual')) return Transmission.MANUAL;
    if (s.includes('automat') || s.includes('auto')) return Transmission.AUTOMATIC;
    return undefined;
  }
}
