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

export const platformFeeBpsSchema = z.number().int().min(0).max(1000);
export const discordChannelSchema = z.object({
  channel_id: discordIdSchema,
  guild_id: discordIdSchema,
  channel_name: z.string().min(1).max(100),
  channel_type: z.enum(['GUILD_TEXT', 'GUILD_ANNOUNCEMENT']),
  can_post: z.boolean(),
  active: z.boolean(),
  last_synced_at: z.string(),
});
export type DiscordChannel = z.infer<typeof discordChannelSchema>;

export const lobbyStatusSchema = z.enum([
  'OPEN',
  'POSTPONED',
  'LOCKED',
  'SETTLED',
  'CANCELLED',
  'ARCHIVED',
]);
export const lobbySchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(80),
  status: lobbyStatusSchema,
  discord_guild_id: discordIdSchema,
  discord_channel_id: discordIdSchema,
  discord_message_id: discordIdSchema.nullable(),
  roster_entry_centavos: centavosSchema.positive(),
  side_betting_enabled: z.boolean(),
  side_bet_min_centavos: centavosSchema.positive().nullable(),
  side_bet_max_centavos: centavosSchema.positive().nullable(),
  platform_fee_bps: platformFeeBpsSchema,
  winner: z.enum(['RADIANT', 'DIRE']).nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  discord_revision: centavosSchema.positive(),
  discord_synced_revision: centavosSchema,
  discord_sync_claimed_at: z.string().nullable(),
  discord_sync_error: z.string().nullable(),
  financial_commitment_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  discord_previous_channel_id: discordIdSchema.nullable(),
  discord_previous_message_id: discordIdSchema.nullable(),
});
export type Lobby = z.infer<typeof lobbySchema>;

export const lobbyPlayerSchema = z.object({
  id: z.uuid(),
  lobby_id: z.uuid(),
  user_id: z.uuid(),
  discord_user_id: discordIdSchema,
  display_name: z.string().min(1).max(100),
  team: z.enum(['RADIANT', 'DIRE']),
  stake_centavos: centavosSchema.positive(),
  status: z.enum(['ACTIVE', 'REMOVED']),
  added_by: z.uuid().nullable(),
  added_source: z.enum(['DASHBOARD', 'DISCORD_SELF_SERVICE']),
  added_at: z.string(),
  removed_by: z.uuid().nullable(),
  removed_at: z.string().nullable(),
  removed_source: z
    .enum(['DASHBOARD', 'DISCORD_SELF_SERVICE', 'LOBBY_CANCELLED'])
    .nullable(),
});
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

export const sideBetSchema = z.object({
  id: z.uuid(),
  bet_number: centavosSchema.positive(),
  lobby_id: z.uuid(),
  user_id: z.uuid(),
  discord_user_id: discordIdSchema,
  display_name: z.string().min(1).max(100),
  side: z.enum(['RADIANT', 'DIRE']),
  requested_amount_centavos: centavosSchema.positive(),
  accepted_amount_centavos: centavosSchema,
  status: z.enum(['ACTIVE', 'CANCELLED']),
  placed_at: z.string(),
  cancelled_at: z.string().nullable(),
  cancelled_source: z
    .enum(['DISCORD_SELF_SERVICE', 'LOBBY_CANCELLED'])
    .nullable(),
  discord_interaction_id: discordIdSchema,
  cancel_interaction_id: discordIdSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SideBet = z.infer<typeof sideBetSchema>;
