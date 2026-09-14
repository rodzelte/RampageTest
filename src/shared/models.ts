import { z } from 'zod';

export const discordIdSchema = z
  .string()
  .regex(/^\d{17,20}$/, 'Invalid Discord user ID');
export const roleSchema = z.enum(['MEMBER', 'ADMIN', 'OWNER']);
export type Role = z.infer<typeof roleSchema>;
export const centavosSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const memberSchema = z.object({
  id: z.uuid(),
  discord_user_id: discordIdSchema,
  auth_user_id: z.uuid().nullable(),
  discord_username: z.string().nullable(),
  display_name: z.string().nullable(),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  created_at: z.string(),
  updated_at: z.string(),
});
export const staffSchema = z.object({
  id: z.uuid(),
  auth_user_id: z.uuid(),
  email: z.email(),
  role: z.enum(['ADMIN', 'OWNER']),
  discord_user_id: discordIdSchema.nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type StaffProfile = z.infer<typeof staffSchema>;
export const authorizationSchema = z.object({
  id: z.uuid(),
  role: roleSchema,
  discord_user_id: discordIdSchema,
});
export const walletSchema = z.object({
  user_id: z.uuid(),
  available_centavos: centavosSchema,
  reserved_centavos: centavosSchema,
  updated_at: z.string(),
});

export const topupStatusSchema = z.enum([
  'PENDING',
  'PAID',
  'EXPIRED',
  'LATE_PAID_REVIEW',
  'AMOUNT_MISMATCH_REVIEW',
  'FAILED',
  'REJECTED',
  'RESOLVED',
]);
export const topupSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  amount_centavos: centavosSchema,
  currency: z.literal('PHP'),
  provider: z.string(),
  provider_payment_id: z.string().nullable(),
  provider_reference: z.string().nullable(),
  provider_event_id: z.string().nullable(),
  status: topupStatusSchema,
  qr_created_at: z.string().nullable(),
  expires_at: z.string(),
  provider_paid_amount_centavos: centavosSchema.nullable(),
  provider_paid_at: z.string().nullable(),
  credited_at: z.string().nullable(),
  reviewed_by: z.uuid().nullable(),
  review_note: z.string().nullable(),
  review_resolution: z.enum(['APPROVED_CREDIT', 'REJECTED_CREDIT']).nullable(),
  resolved_at: z.string().nullable(),
  notification_claimed_at: z.string().nullable(),
  notification_failure_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Topup = z.infer<typeof topupSchema>;
