#!/usr/bin/env node
/**
 * Discord AXON gRPC Client Entry Point (Multi-Bot)
 * Connects multiple Discord bots to the Connectome gRPC server
 *
 * Architecture:
 * - Loads config.json for bot configurations
 * - Parses DISCORD_BOT_TOKENS (comma-separated) and pairs by index with active_bots
 * - Creates one Discord.js Client per bot
 * - Creates one gRPC client per bot
 * - Uses class-based components following Connectome nomenclature
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: 'discord-axon' });

import {
  // Configuration
  loadConfig,
  pairTokensWithBots,
  getGrpcConfig,
  // Bot instance
  createBotInstance,
  // Components
  DiscordReadyReceptor,
  DiscordMessageReceptor,
  DiscordInteractionReceptor,
  DiscordReactionReceptor,
  FocusedContextTransform,
  DiscordCommandEffector,
  DiscordSpeechEffector,
  // Types
  type SharedState,
  type RuntimeConfig,
  type BotInstance
} from './grpc/index.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     DISCORD AXON - gRPC Client Mode (Multi-Bot)        ║');
  console.log('║     Discord bot adapter for Connectome                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  // Load configuration
  const config = loadConfig();
  const { host, port } = getGrpcConfig();
  const guildId = process.env.DISCORD_GUILD_ID;

  console.log('Configuration:');
  console.log(`  Connectome gRPC: ${host}:${port}`);
  console.log(`  Guild ID:        ${guildId || '(all guilds)'}`);
  console.log();

  // Pair tokens with bot configs
  const pairedBots = pairTokensWithBots(config);

  if (pairedBots.length === 0) {
    console.error('Error: No bots configured with tokens');
    process.exit(1);
  }

  console.log();

  console.log(`Initializing ${pairedBots.length} bot(s)...`);
  console.log();

  // Initialize shared state
  const state: SharedState = {
    bots: new Map<string, BotInstance>(),
    botUserIdToName: new Map<string, string>(),
    processingActivations: new Set<string>(),
    botInteractionCounts: new Map<string, number>(),
    runtimeConfig: {
      randomReplyChance: (config as any).random_reply_chance ?? 200,
      maxBotMentionsPerConversation: (config as any).max_bot_mentions_per_conversation ?? 3,
      maxConversationFrames: config.max_conversation_frames || 100,
      maxMemoryFrames: 500
    },
    pairedBots
  };

  // Track context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  const updateRuntimeConfig = (updates: Partial<RuntimeConfig>) => {
    Object.assign(state.runtimeConfig, updates);
    console.log('[RuntimeConfig] Updated:', updates);
    // Propagate mcf changes to all context transforms
    if (updates.maxConversationFrames !== undefined) {
      for (const ct of contextTransforms) {
        ct.setMaxConversationFrames(updates.maxConversationFrames);
      }
    }
  };

  // Initialize each bot
  const allBotNames = pairedBots.map(b => b.name);
  const remoteBotNames = pairedBots.filter(b => b.remote).map(b => b.name);

  for (const botConfig of pairedBots) {
    console.log(`Initializing ${botConfig.name}...`);

    // Create bot instance
    const bot = createBotInstance(botConfig, host, port, guildId);
    state.bots.set(botConfig.name, bot);

    // Create components following Connectome nomenclature

    // 0. DiscordSpeechEffector - handles server-initiated speech/actions
    const speechEffector = new DiscordSpeechEffector({
      botConfig: bot.config,
      discordClient: bot.discord,
      streamManager: bot.streamManager,
      allBotNames,
      remoteBotNames,
      maxMessageLength: config.max_message_length,
      botUserIdToName: state.botUserIdToName,
      activeTypingIntervals: bot.activeTypingIntervals
    });
    speechEffector.setup();

    // 1. FocusedContextTransform - fetches and renders context from server
    const contextTransform = new FocusedContextTransform({
      grpcClient: bot.grpcClient,
      botName: botConfig.name,
      systemPrompt: botConfig.prompt || 'Standard',
      maxConversationFrames: state.runtimeConfig.maxConversationFrames,
      botUserIdToName: state.botUserIdToName,
      skipIdentityPrompt: botConfig.skip_identity_prompt,
    });
    contextTransforms.push(contextTransform);

    // 2. DiscordCommandEffector - handles ! commands
    const commandEffector = new DiscordCommandEffector(botConfig.name);

    // 3. DiscordReadyReceptor - handles Discord ready event
    const readyReceptor = new DiscordReadyReceptor({
      bot,
      state
    });
    readyReceptor.setup();

    // 4. DiscordMessageReceptor - handles Discord messages
    const messageReceptor = new DiscordMessageReceptor({
      bot,
      state,
      commandEffector,
      updateConfig: updateRuntimeConfig
    });
    messageReceptor.setup();

    // 5. DiscordInteractionReceptor - handles slash commands, buttons
    const interactionReceptor = new DiscordInteractionReceptor({ bot });
    interactionReceptor.setup();

    // 6. DiscordReactionReceptor - handles reactions
    const reactionReceptor = new DiscordReactionReceptor({ bot, state });
    reactionReceptor.setup();

    console.log(`  ${botConfig.name}: Components initialized`);
  }

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n\nShutting down...');

    for (const [botName, bot] of state.bots) {
      console.log(`  Disconnecting ${botName}...`);
      bot.streamManager.unsubscribeAll();
      bot.grpcClient.disconnect();
      bot.discord.destroy();
    }

    await Sentry.flush(2000);
    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect all bots
  console.log('\nConnecting to services...');

  for (const [botName, bot] of state.bots) {
    try {
      // Connect to Connectome gRPC server
      await bot.grpcClient.connect();
      console.log(`  ${botName}: Connected to Connectome`);

      // Login to Discord
      await bot.discord.login(bot.config.token);
      console.log(`  ${botName}: Logged in to Discord`);

      console.log(`  ${botName}: Ready for messages`);
    } catch (error: any) {
      console.error(`  ${botName}: Failed to connect: ${error.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Discord AXON running with ${state.bots.size} bot(s)`);
  console.log('  Listening for Discord events...');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nPress Ctrl+C to stop.\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
