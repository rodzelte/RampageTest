import { z } from 'zod';

const absoluteMaximum = 10_000_000;

const botConfigSchema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
    DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
    TOPUP_PROVIDER: z.literal('qrph_mock').default('qrph_mock'),
    TOPUP_MIN_CENTAVOS: z.coerce.number().int().positive().default(10_000),
    TOPUP_MAX_CENTAVOS: z.coerce
      .number()
      .int()
      .positive()
      .max(absoluteMaximum)
      .default(absoluteMaximum),
    TOPUP_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
  })
  .refine((value) => value.TOPUP_MIN_CENTAVOS <= value.TOPUP_MAX_CENTAVOS, {
    message: 'TOPUP_MIN_CENTAVOS cannot exceed TOPUP_MAX_CENTAVOS.',
  })
  .refine(
    (value) =>
      !(
        value.NODE_ENV === 'production' && value.TOPUP_PROVIDER === 'qrph_mock'
      ),
    { message: 'MockQrPhProvider is disabled in production.' },
  );

export function readBotConfig(env: NodeJS.ProcessEnv = process.env) {
  return botConfigSchema.parse(env);
}

export type BotConfig = ReturnType<typeof readBotConfig>;
export const TOPUP_ABSOLUTE_MAX_CENTAVOS = absoluteMaximum;
