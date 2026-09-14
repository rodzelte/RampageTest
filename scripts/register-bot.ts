import { REST, Routes } from 'discord.js';
import { z } from 'zod';
import { commandPayloads } from '../src/bot/commands/registry';

const config = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
    DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  })
  .parse(process.env);

const rest = new REST().setToken(config.DISCORD_BOT_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
  { body: commandPayloads },
);
console.log(`Registered ${commandPayloads.length} guild command(s).`);
