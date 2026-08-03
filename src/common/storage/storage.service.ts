import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Storage, type Bucket } from '@google-cloud/storage';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { promises as fs } from 'fs';

type StorageDriver = 'gcs' | 's3' | 'local';

/**
 * Cross-cutting media storage. Registered `@Global()` (see StorageModule) so any
 * feature service/controller can inject it without importing the module — the
 * same pattern as MailService / GoogleMeetService / FacebookApiService.
 *
 * Three modes, chosen at boot (mirrors the project-wide dev-mode-fallback idea).
 * Priority: GCS → S3 → local disk.
 *  • **GCS mode** — when `GCS_BUCKET` is set, uploads go to Google Cloud Storage
 *    and `upload()` returns a public URL
 *    (`https://storage.googleapis.com/<bucket>/<key>`, or `GCS_PUBLIC_BASE_URL`
 *    if a CDN/custom domain is configured). Credentials come from
 *    `GCS_CREDENTIALS_JSON` (inline service-account JSON), else `GCS_KEY_FILE`
 *    (path to a JSON key), else Application Default Credentials.
 *  • **S3 mode** — when `S3_BUCKET` + `S3_REGION` are set, uploads go to Amazon
 *    S3 and `upload()` returns a public URL
 *    (`https://<bucket>.s3.<region>.amazonaws.com/<key>`, or `S3_PUBLIC_BASE_URL`
 *    if a CloudFront/custom domain is configured).
 *  • **Local-disk mode** — when neither is set, files are written under
 *    `UPLOAD_DEST` (default `./uploads`) and served at `/uploads/*` exactly as
 *    before. Nothing changes for existing dev setups until remote creds are added.
 *
 * Remote buckets are expected to grant **public read** (GCS: `allUsers` →
 * Storage Object Viewer; S3: a public-read bucket policy). This is what makes
 * images publicly fetchable by Facebook and by the storefront — local
 * `/uploads` paths are unreachable from external servers. We never set a
 * per-object ACL (fails under GCS uniform bucket-level access and under the
 * modern S3 default where ACLs are disabled).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  private driver: StorageDriver = 'local';
  private s3: S3Client | null = null;
  private gcsBucket: Bucket | null = null;
  private bucket = '';
  private region = '';
  private publicBase = '';
  private uploadDest = './uploads';
  private _enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.uploadDest = this.config.get<string>('UPLOAD_DEST') || './uploads';

    // Priority 1 — Google Cloud Storage.
    if (this.initGcs()) return;
    // Priority 2 — Amazon S3.
    if (this.initS3()) return;

    // Priority 3 — local disk fallback.
    this._enabled = false;
    this.driver = 'local';
    this.logger.warn(
      'GCS_BUCKET / S3_BUCKET not set — media storage running in LOCAL DISK mode ' +
        '(uploads saved to ./uploads, served at /uploads/*). Set GCS_* (or S3_*) to ' +
        'store in the cloud — required for public image URLs reachable from the ' +
        'storefront and Facebook, and to survive Render redeploys.',
    );
  }

  /** Init Google Cloud Storage; returns true when GCS mode is active. */
  private initGcs(): boolean {
    this.bucket = (this.config.get<string>('GCS_BUCKET') ?? '').trim();
    if (!this.bucket) return false;

    const projectId = (this.config.get<string>('GCS_PROJECT_ID') ?? '').trim();
    const credsJson = (this.config.get<string>('GCS_CREDENTIALS_JSON') ?? '').trim();
    const keyFile = (this.config.get<string>('GCS_KEY_FILE') ?? '').trim();
    const publicBase = (this.config.get<string>('GCS_PUBLIC_BASE_URL') ?? '').trim();

    try {
      const opts: ConstructorParameters<typeof Storage>[0] = {};
      if (projectId) opts.projectId = projectId;
      if (credsJson) opts.credentials = JSON.parse(credsJson);
      else if (keyFile) opts.keyFilename = keyFile;
      // else: fall back to Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).

      const storage = new Storage(opts);
      this.gcsBucket = storage.bucket(this.bucket);
      this.publicBase = (
        publicBase || `https://storage.googleapis.com/${this.bucket}`
      ).replace(/\/+$/, '');
      this.driver = 'gcs';
      this._enabled = true;
      this.logger.log(`☁️  GCS storage ready (bucket=${this.bucket})`);
      return true;
    } catch (err) {
      this.gcsBucket = null;
      this.logger.error(
        `GCS init failed (${err instanceof Error ? err.message : err}) — ` +
          'check GCS_CREDENTIALS_JSON / GCS_KEY_FILE. Trying next storage driver.',
      );
      return false;
    }
  }

  /** Init Amazon S3; returns true when S3 mode is active. */
  private initS3(): boolean {
    this.bucket = (this.config.get<string>('S3_BUCKET') ?? '').trim();
    this.region = (this.config.get<string>('S3_REGION') ?? '').trim();
    if (!this.bucket || !this.region) return false;

    const accessKeyId = (this.config.get<string>('S3_ACCESS_KEY_ID') ?? '').trim();
    const secretAccessKey = (this.config.get<string>('S3_SECRET_ACCESS_KEY') ?? '').trim();
    const publicBase = (this.config.get<string>('S3_PUBLIC_BASE_URL') ?? '').trim();

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
      this.driver = 's3';
      this._enabled = true;
      this.logger.log(`☁️  S3 storage ready (bucket=${this.bucket}, region=${this.region})`);
      return true;
    } catch (err) {
      this.s3 = null;
      this.logger.error(
        `S3 init failed (${err instanceof Error ? err.message : err}) — ` +
          'falling back to LOCAL DISK mode.',
      );
      return false;
    }
  }

  /** True when uploads go to a cloud bucket (public URLs). */
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

    if (this._enabled && this.driver === 'gcs' && this.gcsBucket) {
      await this.gcsBucket.file(key).save(buffer, {
        contentType: mimeType || 'application/octet-stream',
        metadata: { cacheControl: 'public, max-age=31536000' },
        resumable: false,
      });
      return `${this.publicBase}/${key}`;
    }

    if (this._enabled && this.driver === 's3' && this.s3) {
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
        this.publicBase &&
        urlOrPath.startsWith(`${this.publicBase}/`)
      ) {
        const key = urlOrPath.slice(this.publicBase.length + 1);
        if (this.driver === 'gcs' && this.gcsBucket) {
          await this.gcsBucket.file(key).delete({ ignoreNotFound: true });
          return;
        }
        if (this.driver === 's3' && this.s3) {
          await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
          return;
        }
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
