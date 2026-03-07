#!/usr/bin/env node
/**
 * Discord AXON gRPC Client Entry Point (Multi-Bot)
 * Connects multiple Discord bots to the Connectome gRPC server
 *
 * Architecture:
 * - Tokens arrive via DISCORD_BOT_TOKENS env var (startup batch) and/or
 *   AxonBindingServer advertisements from bot-runtimes (dynamic)
 * - Each token is logged into Discord to discover bot identity (name, userId)
 * - Creates one gRPC client per discovered bot
 * - Uses class-based components following Connectome nomenclature
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: 'discord-axon' });

import { AxonBindingServer } from '@connectome/axon-binding';
import type { AxonBinding } from '@connectome/axon-binding';

import {
  // Configuration
  getTokens,
  getGrpcConfig,
  getOperationalConfig,
  // Bot instance
  createDiscordClient,
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

  // Load configuration from environment
  const tokens = getTokens();
  const operationalConfig = getOperationalConfig();
  const { host, port } = getGrpcConfig();
  const guildId = process.env.DISCORD_GUILD_ID;
  const bindingPort = parseInt(process.env.AXON_BINDING_PORT || '0');

  console.log('Configuration:');
  console.log(`  Connectome gRPC:    ${host}:${port}`);
  console.log(`  Guild ID:           ${guildId || '(all guilds)'}`);
  console.log(`  Tokens (env):       ${tokens.length}`);
  console.log(`  Axon binding:   ${bindingPort || 'disabled'}`);
  console.log();

  // Build managed bot name set (for speech routing)
  const managedBotNames = new Set<string>();

  // Initialize shared state
  const state: SharedState = {
    bots: new Map<string, BotInstance>(),
    botUserIdToName: new Map<string, string>(),
    processingActivations: new Set<string>(),
    botInteractionCounts: new Map<string, number>(),
    runtimeConfig: {
      randomReplyChance: operationalConfig.randomReplyChance,
      maxBotMentionsPerConversation: operationalConfig.maxBotMentionsPerConversation,
      maxConversationFrames: operationalConfig.maxConversationFrames,
      maxMemoryFrames: operationalConfig.maxMemoryFrames
    }
  };

  // Track context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  const updateRuntimeConfig = (updates: Partial<RuntimeConfig>) => {
    Object.assign(state.runtimeConfig, updates);
    console.log('[RuntimeConfig] Updated:', updates);
    if (updates.maxConversationFrames !== undefined) {
      for (const ct of contextTransforms) {
        ct.setMaxConversationFrames(updates.maxConversationFrames);
      }
    }
  };

  // ========================================================================
  // addBot — reusable: login a token, create components, connect gRPC
  // Called both at startup (env tokens) and dynamically (binding ads)
  // ========================================================================
  async function addBot(token: string, source: string, agentName?: string): Promise<string | null> {
    try {
      const discord = createDiscordClient();
      const readyPromise = new Promise<void>((resolve) => discord.once('ready', () => resolve()));
      await discord.login(token);
      await readyPromise;

      const name = discord.user!.username;
      const userId = discord.user!.id;

      // Skip if already managed
      if (state.bots.has(name)) {
        console.log(`  ${name}: Already managed, skipping (${source})`);
        discord.destroy();
        return name;
      }

      console.log(`  Discovered: ${name} (${userId}) [${source}]${agentName ? ` agentName=${agentName}` : ''}`);
      managedBotNames.add(name);
      if (agentName) managedBotNames.add(agentName);

      // Create bot instance from pre-logged-in Discord client
      const bot = createBotInstance(discord, host, port, guildId);
      if (agentName) bot.config.agentName = agentName;
      state.bots.set(name, bot);
      state.botUserIdToName.set(userId, name);

      // Create components
      const speechEffector = new DiscordSpeechEffector({
        botConfig: bot.config,
        discordClient: bot.discord,
        streamManager: bot.streamManager,
        managedBotNames,
        maxMessageLength: operationalConfig.maxMessageLength,
        botUserIdToName: state.botUserIdToName,
        activeTypingIntervals: bot.activeTypingIntervals
      });
      speechEffector.setup();

      const contextTransform = new FocusedContextTransform({
        grpcClient: bot.grpcClient,
        botName: name,
        systemPrompt: 'Standard',
        maxConversationFrames: state.runtimeConfig.maxConversationFrames,
        botUserIdToName: state.botUserIdToName,
      });
      contextTransforms.push(contextTransform);

      const commandEffector = new DiscordCommandEffector(name);

      const readyReceptor = new DiscordReadyReceptor({ bot, state });
      readyReceptor.setup();

      const messageReceptor = new DiscordMessageReceptor({
        bot, state, commandEffector, updateConfig: updateRuntimeConfig
      });
      messageReceptor.setup();

      const interactionReceptor = new DiscordInteractionReceptor({ bot });
      interactionReceptor.setup();

      const reactionReceptor = new DiscordReactionReceptor({ bot, state });
      reactionReceptor.setup();

      // Connect gRPC
      await bot.grpcClient.connect();
      console.log(`  ${name}: Components initialized, gRPC connected [${source}]`);

      return name;
    } catch (error: any) {
      console.error(`  Failed to add bot (${source}): ${error.message}`);
      return null;
    }
  }

  // ========================================================================
  // Step 1: Start AxonBindingServer FIRST (so bot-runtimes can connect
  // while env-based bots are still logging in)
  // ========================================================================
  let bindingServer: AxonBindingServer | undefined;

  if (bindingPort > 0) {
    bindingServer = new AxonBindingServer({ port: bindingPort });

    bindingServer.on('binding:added', async (binding: AxonBinding) => {
      if (binding.platform !== 'discord') {
        console.log(`[AxonBinding] Ignoring non-discord binding: ${binding.agentName} → ${binding.platform}`);
        return;
      }

      const token = binding.credentials.token;
      if (!token) {
        console.error(`[AxonBinding] Discord binding for ${binding.agentName} missing token`);
        return;
      }

      console.log(`[AxonBinding] Adding bot ${binding.agentName}...`);
      await addBot(token, `binding:${binding.agentName}`, binding.agentName);
    });

    await bindingServer.start();
  }

  // ========================================================================
  // Step 2: Login bots from DISCORD_BOT_TOKENS env var (startup batch)
  // ========================================================================
  if (tokens.length > 0) {
    console.log(`Logging in ${tokens.length} bot(s) from env...`);

    for (const token of tokens) {
      await addBot(token, 'env');
    }

    console.log(`  ${state.bots.size} bot(s) initialized from env`);
    console.log();
  }

  if (state.bots.size === 0 && !bindingServer) {
    console.error('Error: No bots initialized and no binding server running');
    process.exit(1);
  }

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n\nShutting down...');

    if (bindingServer) {
      await bindingServer.stop();
    }

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

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Discord AXON running with ${state.bots.size} bot(s)`);
  if (bindingServer) {
    console.log(`  Axon binding server on port ${bindingPort}`);
  }
  console.log('  Listening for Discord events...');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nPress Ctrl+C to stop.\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
