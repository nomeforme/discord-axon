/**
 * Bot instance management for Discord AXON gRPC mode
 * Handles creation and setup of individual bot instances
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { DiscordGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import type { BotConfig, BotInstance } from './types.js';

/**
 * Create a Discord.js client with proper intents
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction
    ]
  });
}

/**
 * Create a bot instance from a pre-logged-in Discord client
 *
 * Name is discovered from Discord (client.user.username), not from static config.
 */
export function createBotInstance(
  discord: Client,
  grpcHost: string,
  grpcPort: number,
  guildId?: string
): BotInstance {
  const name = discord.user!.username;
  const userId = discord.user!.id;

  const botConfig: BotConfig = {
    name,
    guild_id: guildId,
  };

  // Create gRPC client using the discovered name
  const grpcClient = new DiscordGrpcClient({
    serverHost: grpcHost,
    serverPort: grpcPort,
    clientId: `discord-${name}`,
    botName: name,
    guildId: botConfig.guild_id ?? guildId
  });

  // Create stream manager for this bot
  const streamManager = new StreamManager(grpcClient);

  const botInstance: BotInstance = {
    config: botConfig,
    discord,
    grpcClient,
    streamManager,
    userId,
    activeTypingIntervals: new Map()
  };

  // All bots are remote — cognition delegated to standalone bot-runtime containers
  console.log(`  ${name}: Remote mode — cognition delegated to bot-runtime`);

  return botInstance;
}
