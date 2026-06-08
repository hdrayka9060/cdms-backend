import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { promises as fs } from 'fs';

/**
 * Cross-cutting media storage. Registered `@Global()` (see StorageModule) so any
 * feature service/controller can inject it without importing the module — the
 * same pattern as MailService / GoogleMeetService / FacebookApiService.
 *
 * Two modes, chosen at boot (mirrors the project-wide dev-mode-fallback idea):
 *  • **S3 mode** — when `S3_BUCKET` + `S3_REGION` are set, uploads go to Amazon
 *    S3 and `upload()` returns a public URL
 *    (`https://<bucket>.s3.<region>.amazonaws.com/<key>`, or `S3_PUBLIC_BASE_URL`
 *    if a CloudFront/custom domain is configured). This is what makes images
 *    publicly fetchable by Facebook (local `/uploads` paths are unreachable from
 *    Facebook's servers).
 *  • **Local-disk mode** — when `S3_BUCKET` is empty, files are written under
 *    `UPLOAD_DEST` (default `./uploads`) and served at `/uploads/*` exactly as
 *    before. Nothing changes for existing dev setups until S3 creds are added.
 *
 * Bucket expectations (S3 mode): objects are made readable by a **public-read
 * bucket policy** (`s3:GetObject` for `*`). We therefore never set an object
 * `ACL` — that fails under the modern default (Object Ownership = bucket-owner
 * enforced, ACLs disabled).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  private s3: S3Client | null = null;
  private bucket = '';
  private region = '';
  private publicBase = '';
  private uploadDest = './uploads';
  private _enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.uploadDest = this.config.get<string>('UPLOAD_DEST') || './uploads';
    this.bucket = (this.config.get<string>('S3_BUCKET') ?? '').trim();
    this.region = (this.config.get<string>('S3_REGION') ?? '').trim();
    const accessKeyId = (this.config.get<string>('S3_ACCESS_KEY_ID') ?? '').trim();
    const secretAccessKey = (this.config.get<string>('S3_SECRET_ACCESS_KEY') ?? '').trim();
    const publicBase = (this.config.get<string>('S3_PUBLIC_BASE_URL') ?? '').trim();

    if (!this.bucket || !this.region) {
      this._enabled = false;
      this.logger.warn(
        'S3_BUCKET/S3_REGION not set — media storage running in LOCAL DISK mode ' +
          '(uploads saved to ./uploads, served at /uploads/*). Set S3_* to store ' +
          'on Amazon S3 — required for public image URLs that Facebook can fetch.',
      );
      return;
    }

    try {
      this.s3 = new S3Client({
        region: this.region,
        // When creds are omitted the SDK falls back to its default provider
        // chain (env AWS_*, shared config, or an instance/role profile).
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
      });
      this.publicBase = (
        publicBase || `https://${this.bucket}.s3.${this.region}.amazonaws.com`
      ).replace(/\/+$/, '');
      this._enabled = true;
      this.logger.log(`☁️  S3 storage ready (bucket=${this.bucket}, region=${this.region})`);
    } catch (err) {
      this._enabled = false;
      this.logger.error(
        `S3 init failed (${err instanceof Error ? err.message : err}) — ` +
          'falling back to LOCAL DISK mode.',
      );
    }
  }

  /** True when uploads go to Amazon S3 (public URLs). */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Persist an uploaded file buffer and return a URL the frontend (via
   * `fileUrl()`) and Facebook can load.
   *  • S3 mode → absolute `${publicBase}/<key>`
   *  • Local mode → relative `/uploads/<prefix>/<file>` (served statically)
   * `prefix` groups objects by domain (e.g. 'vehicles', 'tickets', 'messages').
   */
  async upload(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    prefix = 'vehicles',
  ): Promise<string> {
    const ext = extname(originalName || '') || this.extFromMime(mimeType);
    const filename = `${randomUUID()}${ext}`;
    const key = `${prefix}/${filename}`;

    if (this._enabled && this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType || 'application/octet-stream',
          CacheControl: 'public, max-age=31536000',
        }),
      );
      return `${this.publicBase}/${key}`;
    }

    // Local-disk fallback (preserves the pre-S3 behaviour exactly).
    const root = this.uploadDest.replace(/^\.\//, '');
    const dir = join(process.cwd(), root, prefix);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, filename), buffer);
    return `/uploads/${prefix}/${filename}`;
  }

  /**
   * Best-effort delete of a previously-stored object. Accepts either an S3
   * public URL (for our bucket) or a local `/uploads/...` path — so it correctly
   * cleans up legacy local files even after switching to S3. Never throws.
   */
  async remove(urlOrPath: string): Promise<void> {
    if (!urlOrPath) return;
    try {
      if (
        this._enabled &&
        this.s3 &&
        this.publicBase &&
        urlOrPath.startsWith(`${this.publicBase}/`)
      ) {
        const key = urlOrPath.slice(this.publicBase.length + 1);
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return;
      }
      if (urlOrPath.startsWith('/uploads/')) {
        const root = this.uploadDest.replace(/^\.\//, '');
        const rel = urlOrPath.replace(/^\/uploads\//, '');
        await fs.unlink(join(process.cwd(), root, rel)).catch(() => undefined);
      }
      // Any other absolute URL (different bucket / CDN) — nothing to clean up.
    } catch (err) {
      this.logger.warn(
        `storage.remove failed for ${urlOrPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private extFromMime(mime: string): string {
    switch ((mime || '').toLowerCase()) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/gif':
        return '.gif';
      default:
        return '';
    }
  }
}
