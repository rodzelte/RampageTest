export type CreateQrPhTopupInput = {
  topupId: string;
  amountCentavos: number;
  expiresAt: Date;
};

export type CreatedQrPhTopup = {
  providerPaymentId: string;
  providerReference?: string;
  qrPayload?: string;
  qrImageBuffer?: Buffer;
  qrImageUrl?: string;
  expiresAt: Date;
};

export type VerifiedQrPhEvent = {
  provider: string;
  providerPaymentId: string;
  providerEventId: string;
  paidAmountCentavos: number;
  currency: 'PHP';
  paidAt: Date;
  success: boolean;
};

export interface QrPhProvider {
  readonly name: string;
  createTopup(input: CreateQrPhTopupInput): Promise<CreatedQrPhTopup>;
  verifyWebhook(request: Request): Promise<VerifiedQrPhEvent>;
}
