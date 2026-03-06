import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  signedUrlExpiry: number; // seconds
}

export interface UploadParams {
  key: string;
  content: Buffer;
  contentType: string;
}

export interface UploadResult {
  key: string;
  signedUrl: string;
  expiresAt: Date;
}

export class StorageService {
  private client: S3Client;
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
  }

  async ensureBucket(): Promise<void> {
    if (!this.config.endpoint || !this.config.accessKey) return;
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
    } catch {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
      );
    }
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: params.key,
        Body: params.content,
        ContentType: params.contentType,
      }),
    );

    const signedUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: params.key,
      }),
      { expiresIn: this.config.signedUrlExpiry },
    );

    const expiresAt = new Date(
      Date.now() + this.config.signedUrlExpiry * 1000,
    );

    return {
      key: params.key,
      signedUrl,
      expiresAt,
    };
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    const stream = response.Body;
    if (!stream) {
      throw new Error(`No body returned for key: ${key}`);
    }

    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }
}
