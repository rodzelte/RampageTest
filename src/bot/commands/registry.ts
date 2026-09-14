import { SlashCommandBuilder } from 'discord.js';

export const commandRegistry = [
  new SlashCommandBuilder()
    .setName('topup')
    .setDescription('Create a private QR Ph top-up code')
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('PHP amount, for example 500 or 500.50')
        .setRequired(true),
    ),
] as const;

export const commandPayloads = commandRegistry.map((command) =>
  command.toJSON(),
);
