/**
 * Bot instance management for Discord AXON gRPC mode
 * Handles creation and setup of individual bot instances
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { DiscordGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import { cleanSpeechContent, splitMessage } from './utils/index.js';
import type { BotConfig, BotInstance } from './types.js';

/**
 * Create a Discord.js client with proper intents
 */
function createDiscordClient(): Client {
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
 * Create a bot instance (without connecting)
 */
export function createBotInstance(
  botConfig: BotConfig,
  grpcHost: string,
  grpcPort: number,
  guildId?: string
): BotInstance {
  // Create Discord.js client
  const discord = createDiscordClient();

  // Create gRPC client for this bot
  const grpcClient = new DiscordGrpcClient({
    serverHost: grpcHost,
    serverPort: grpcPort,
    clientId: `discord-${botConfig.name}`,
    botName: botConfig.name,
    guildId: botConfig.guild_id ?? guildId
  });

  // Create stream manager for this bot
  const streamManager = new StreamManager(grpcClient);

  // Create the instance
  const botInstance: BotInstance = {
    config: botConfig,
    discord,
    grpcClient,
    streamManager,
    activeTypingIntervals: new Map()
  };

  // All bots are remote — cognition delegated to standalone bot-runtime containers
  console.log(`  ${botConfig.name}: Remote mode — cognition delegated to bot-runtime`);

  return botInstance;
}

/**
 * Set up speech handler for a bot (handles server-generated speech)
 */
export function setupSpeechHandler(
  bot: BotInstance,
  allBotNames: string[],
  maxMessageLength?: number
): void {
  const botName = bot.config.name;

  bot.streamManager.onSpeech(async (facet, streamInfo) => {
    // Skip speech from any bot in our system - they all send directly to Discord
    const isFromOurBot = allBotNames.includes(facet.agentId || '') ||
                         allBotNames.includes(facet.agentName || '');
    if (isFromOurBot) {
      console.log(`[${botName}] Skipping speech from our bot ${facet.agentName || facet.agentId}`);
      return;
    }

    console.log(`[${botName}] Sending message to ${streamInfo.channelName || streamInfo.channelId}`);

    try {
      // Clean speech content (strip XML tags, extract tool syntax)
      const cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent) return;

      const channel = await bot.discord.channels.fetch(streamInfo.channelId);
      if (channel && 'send' in channel) {
        // Split if too long
        const chunks = splitMessage(cleanedContent, maxMessageLength);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    } catch (error: any) {
      console.error(`[${botName}] Error sending message:`, error.message);
    }
  });
}

/**
 * Set up action handler for a bot
 */
export function setupActionHandler(bot: BotInstance): void {
  const botName = bot.config.name;

  bot.streamManager.onAction(async (facet, _streamInfo) => {
    const action = facet.state;
    console.log(`[${botName}] Executing action: ${action?.toolName}`);

    try {
      switch (action?.toolName) {
        case 'addReaction':
          // Handle reaction action
          break;
        case 'sendEmbed':
          // Handle embed action
          break;
        default:
          console.log(`[${botName}] Unknown action type: ${action?.toolName}`);
      }
    } catch (error: any) {
      console.error(`[${botName}] Error executing action:`, error.message);
    }
  });
}
