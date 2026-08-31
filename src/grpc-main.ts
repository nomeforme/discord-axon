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
  SubstreamRelayEffector,
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
      maxMemoryFrames: operationalConfig.maxMemoryFrames,
      mcfStreamOverrides: {}
    }
  };

  // Track context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  // Workflow relay: created once after the first bot connects
  let substreamRelay: SubstreamRelayEffector | null = null;

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
    // Hoisted so the catch can roll back whatever was already registered.
    // Without this, a failure AFTER state.bots.set() (e.g. gRPC connect timing
    // out during a connectome blip) leaves a half-built bot behind: Discord
    // receptors live, agentHandle undefined. Messages still reach VEIL because
    // emitDiscordMessage doesn't check the handle, but every activateAgent
    // throws 'Not connected'. And because the entry is in state.bots, all later
    // retries short-circuit on 'Already managed, skipping' — so the bot stays
    // deaf until the axon restarts. Cost us claude-opus-5 on Discord for
    // three weeks (2026-08-06 → 2026-08-29) while it looked healthy.
    let discord: ReturnType<typeof createDiscordClient> | undefined;
    let name: string | undefined;
    let registered = false;
    try {
      discord = createDiscordClient();
      const readyPromise = new Promise<void>((resolve) => discord!.once('ready', () => resolve()));
      await discord.login(token);
      await readyPromise;

      name = discord.user!.username;
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
      registered = true;

      // Create components
      const speechEffector = new DiscordSpeechEffector({
        botConfig: bot.config,
        discordClient: bot.discord,
        streamManager: bot.streamManager,
        managedBotNames,
        maxMessageLength: operationalConfig.maxMessageLength,
        botUserIdToName: state.botUserIdToName,
        activeTypingIntervals: bot.activeTypingIntervals,
        grpcClient: bot.grpcClient,
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

      const commandEffector = new DiscordCommandEffector(agentName || name);

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

      // Subscribe to typing-stop events (bot-runtime signals cycle completion)
      bot.grpcClient.subscribeToTypingStop((agentName, streamId) => {
        // Match by agentName (bot-runtime name) to this bot's name or agentName
        if (agentName !== name && agentName !== bot.config.agentName) return;
        const interval = bot.activeTypingIntervals?.get(streamId);
        if (interval) {
          clearInterval(interval);
          bot.activeTypingIntervals?.delete(streamId);
          console.log(`[TypingStop:${name}] Cleared typing interval for ${streamId}`);
        }
      });

      // Start substream relay after the first bot connects (singleton)
      if (!substreamRelay) {
        substreamRelay = new SubstreamRelayEffector({ state });
        substreamRelay.setup();
        console.log(`  [SubstreamRelay] Started (using ${name}'s gRPC connection)`);
      }

      console.log(`  ${name}: Components initialized, gRPC connected [${source}]`);

      return name;
    } catch (error: any) {
      console.error(`  Failed to add bot (${source}): ${error.message}`);
      // Roll back, so a later advertisement can retry cleanly instead of being
      // turned away by the 'Already managed' guard. Order matters: drop the
      // registry entries first, then tear down the transports.
      if (registered && name) {
        const partial = state.bots.get(name);
        state.bots.delete(name);
        for (const [userId, botName] of state.botUserIdToName) {
          if (botName === name) state.botUserIdToName.delete(userId);
        }
        managedBotNames.delete(name);
        if (agentName) managedBotNames.delete(agentName);
        try {
          partial?.streamManager.unsubscribeAll();
          partial?.grpcClient.disconnect();
        } catch (cleanupError: any) {
          console.error(`  Cleanup after failed add (${source}): ${cleanupError.message}`);
        }
        console.error(`  Rolled back partial registration for ${name} (${source})`);
      }
      // Always destroy the Discord client — otherwise its receptors keep
      // listening and the bot appears online while being unable to activate.
      try {
        discord?.destroy();
      } catch {
        /* already destroyed or never logged in */
      }
      return null;
    }
  }

  /**
   * A bot counts as healthy only if it is in state.bots AND its gRPC client
   * actually holds an agent handle. Presence alone is not enough: that was
   * precisely the opus-5 failure — present, receiving Discord messages, and
   * unable to activate, because registerAgent never completed.
   *
   * Matches on the bot-runtime agentName or the Discord username, since
   * bindings are keyed by the former and state.bots by the latter.
   */
  function isBotHealthy(agentName: string): boolean {
    for (const [name, bot] of state.bots) {
      if (name !== agentName && bot.config.agentName !== agentName) continue;
      return bot.grpcClient.getAgentId() !== undefined;
    }
    return false;
  }

  /** Per-agent retry backoff for failed adds (see binding:added below). */
  const addBackoff = new Map<string, { failures: number; nextAttempt: number }>();

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

      const agent = binding.agentName;

      // Already healthy? Nothing to do. This check MUST happen before addBot,
      // because addBot has to log into Discord before it can learn the username
      // it keys state.bots by. Discord rate-limits IDENTIFY hard (~1000/day per
      // bot), and the retry loop below fires every 30s — so an unguarded retry
      // path would burn a day's budget in under nine hours.
      if (isBotHealthy(agent)) {
        addBackoff.delete(agent);
        return;
      }

      const backoff = addBackoff.get(agent);
      if (backoff && Date.now() < backoff.nextAttempt) return;

      console.log(`[AxonBinding] Adding bot ${agent}...`);
      const added = await addBot(token, `binding:${agent}`, agent);

      if (added && isBotHealthy(agent)) {
        addBackoff.delete(agent);
        return;
      }

      // Failed. Drop the binding so the advertiser's next 30s keepalive is seen
      // as new and re-emits — turning the existing keepalive into the retry
      // channel — and back off so a prolonged connectome outage doesn't spend
      // the Discord login budget.
      const failures = (backoff?.failures ?? 0) + 1;
      const delayMs = Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000);
      addBackoff.set(agent, { failures, nextAttempt: Date.now() + delayMs });
      bindingServer!.forgetBinding('discord', agent);
      console.error(
        `[AxonBinding] ${agent} not usable after add (failure ${failures}); ` +
        `will retry via keepalive in ~${Math.round(delayMs / 1000)}s`
      );
    });

    await bindingServer.start();

    // Reconciliation sweep: catch bots that are recorded as bound but have no
    // working entry, regardless of HOW they got that way. Only forgets bindings
    // with no healthy bot, which lets the keepalive re-add them; it never tears
    // down a bot that is merely mid-reconnect.
    setInterval(() => {
      for (const b of bindingServer!.getBindings('discord')) {
        if (isBotHealthy(b.agentName)) continue;
        if (bindingServer!.forgetBinding('discord', b.agentName)) {
          console.error(`[AxonBinding] Reconcile: ${b.agentName} bound but not usable — re-adding via keepalive`);
        }
      }
    }, 60_000).unref?.();
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

    if (substreamRelay) {
      substreamRelay.destroy();
      substreamRelay = null;
    }

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
