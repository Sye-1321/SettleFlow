import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type WebhookEndpointStatus = 'active' | 'inactive';
export type WebhookSubscription = 'payment.created.v1';

export interface MerchantWebhookActor {
  readonly actorApiKeyId: string;
  readonly merchantId: string;
  readonly requestId: string;
}

export interface WebhookEndpointRecord {
  readonly createdAt: Date;
  readonly id: string;
  readonly merchantId: string;
  readonly normalizedUrl: string;
  readonly publicId: string;
  readonly status: WebhookEndpointStatus;
  readonly subscriptions: readonly WebhookSubscription[];
  readonly updatedAt: Date;
  readonly version: number;
}

export interface WebhookEndpointRepresentation {
  readonly createdAt: string;
  readonly id: string;
  readonly status: WebhookEndpointStatus;
  readonly subscriptions: readonly WebhookSubscription[];
  readonly updatedAt: string;
  readonly url: string;
  readonly version: number;
}

export interface CreatedWebhookEndpointRepresentation extends WebhookEndpointRepresentation {
  readonly secret: string;
}

export interface RotatedWebhookSecretRepresentation {
  readonly id: string;
  readonly previousSecretExpiresAt: string;
  readonly secret: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface WebhookEndpointPage {
  readonly records: readonly WebhookEndpointRecord[];
  readonly nextPublicId: string | undefined;
}

export interface EncryptedWebhookSecret {
  readonly algorithm: 'aes-256-gcm';
  readonly authenticationTag: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly encryptionKeyId: string;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly secretVersion: number;
}

export interface CreateWebhookEndpointPersistence {
  readonly createdAt: Date;
  readonly encryptedSecret: EncryptedWebhookSecret;
  readonly id: string;
  readonly merchantId: string;
  readonly normalizedUrl: string;
  readonly publicId: string;
  readonly subscriptions: readonly WebhookSubscription[];
}

export interface WebhookEndpointMutation {
  readonly status?: WebhookEndpointStatus;
  readonly subscriptions?: readonly WebhookSubscription[];
  readonly updatedAt: Date;
  readonly version: number;
}

export interface WebhookSecretRotationPersistence {
  readonly encryptedSecret: EncryptedWebhookSecret;
  readonly overlapExpiresAt: Date;
  readonly rotatedAt: Date;
  readonly version: number;
}

export interface WebhookRotationContext {
  readonly endpointId: string;
  readonly publicId: string;
  readonly secretVersion: number;
  readonly version: number;
}

export interface WebhookEndpointRepository {
  create(
    transaction: PrismaTransactionClient,
    input: CreateWebhookEndpointPersistence,
  ): Promise<WebhookEndpointRecord>;
  findByPublicId(merchantId: string, publicId: string): Promise<WebhookEndpointRecord | undefined>;
  findRotationContext(
    merchantId: string,
    publicId: string,
  ): Promise<WebhookRotationContext | undefined>;
  list(
    merchantId: string,
    afterPublicId: string | undefined,
    limit: number,
  ): Promise<WebhookEndpointPage>;
  lockByPublicId(
    transaction: PrismaTransactionClient,
    merchantId: string,
    publicId: string,
  ): Promise<WebhookEndpointRecord | undefined>;
  rotateSecret(
    transaction: PrismaTransactionClient,
    endpointId: string,
    input: WebhookSecretRotationPersistence,
  ): Promise<WebhookEndpointRecord>;
  update(
    transaction: PrismaTransactionClient,
    endpointId: string,
    input: WebhookEndpointMutation,
  ): Promise<WebhookEndpointRecord>;
  withTransaction<T>(operation: (transaction: PrismaTransactionClient) => Promise<T>): Promise<T>;
}

export interface WebhookUrlPolicy {
  normalizeAndValidate(rawUrl: string): Promise<string>;
}
