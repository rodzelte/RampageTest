import { SlashCommandBuilder } from 'discord.js';

export const commandRegistry = [
  new SlashCommandBuilder()
    .setName('lobbies')
    .setDescription('Privately list OPEN Rampage lobbies available to join'),
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a team and reserve the fixed roster-entry stake')
    .addStringOption((option) =>
      option
        .setName('lobby')
        .setDescription('Select an OPEN lobby')
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('team')
        .setDescription('Choose the team you will play for')
        .addChoices(
          { name: 'Radiant', value: 'RADIANT' },
          { name: 'Dire', value: 'DIRE' },
        )
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('Confirm the exact fixed lobby entry in PHP')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave an OPEN lobby and release your roster stake')
    .addStringOption((option) =>
      option
        .setName('lobby')
        .setDescription('Select an OPEN lobby where you are playing')
        .setAutocomplete(true)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Place a private side bet on an OPEN Rampage lobby')
    .addStringOption((option) =>
      option
        .setName('lobby')
        .setDescription('Select an OPEN lobby')
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('side')
        .setDescription('Choose the side')
        .addChoices(
          { name: 'Radiant', value: 'RADIANT' },
          { name: 'Dire', value: 'DIRE' },
        )
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('PHP amount, for example 100 or 100.50')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('cancelbet')
    .setDescription(
      'Cancel one of your ACTIVE side bets while its lobby is OPEN',
    )
    .addIntegerOption((option) =>
      option
        .setName('bet')
        .setDescription('Bet number shown in your confirmation, without #')
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('topup')
    .setDescription('Add funds using a private QR Ph top-up code')
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('PHP amount, for example 500 or 500.50')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('View your private Rampage wallet'),
  new SlashCommandBuilder()
    .setName('transactions')
    .setDescription('View your private recent wallet history'),
] as const;

export const commandPayloads = commandRegistry.map((command) =>
  command.toJSON(),
);
