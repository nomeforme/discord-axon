#!/usr/bin/env node

/**
 * Combined entry point for Discord AXON
 *
 * Starts both the AXON server (Discord bridge + module serving)
 * and the ConnectomeHost application in a single process.
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CombinedDiscordAxonServer } from './server';
import { loadConfig } from './config';
import {
  ConnectomeHost,
  MockLLMProvider,
  DebugLLMProvider,
  VEILStateManager
} from 'connectome-ts';
import { DiscordApplication } from './discord-app.js';
import { AnthropicToolProvider } from './anthropic-tool-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { ToolLoopAgent } from './tool-loop-agent.js';
import { DiscordAgentEffector } from './discord-agent-effector.js';
import { SpeakerPrefixReceptor } from './speaker-prefix-receptor.js';

// Load environment variables from .env file
dotenv.config();

// Import BotConfig from server to ensure type compatibility
import type { BotConfig } from './server';

// Extended config interface for combined-start specific fields
interface ExtendedBotConfig extends BotConfig {
  persist_history?: boolean;
  tools?: string[];
}

interface DiscordBotConfig {
  active_bots?: string[];  // Names of bot configs to activate (multi-bot support)
  active_bot?: string;     // Legacy: single bot name (backwards compat)
  bots: ExtendedBotConfig[];
  default_model?: string;
  default_system_instruction?: string;
  max_tokens?: number;
  max_conversation_frames?: number;
  max_memory_frames?: number;
}

// Load bot configuration from config.json
// Tokens are read from DISCORD_BOT_TOKENS env var (comma-separated)
// and paired with active_bots in order (like BOT_PHONE_NUMBERS in signal-axon-host)
function loadBotConfig(): DiscordBotConfig {
  try {
    const configPath = join(process.cwd(), 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log(`📋 Loaded config.json with ${config.bots?.length || 0} bot(s)`);

    // Get tokens from DISCORD_BOT_TOKENS env var (comma-separated)
    const tokensEnv = process.env.DISCORD_BOT_TOKENS || '';
    const tokens = tokensEnv.split(',').map(t => t.trim()).filter(t => t);

    // Get active bots list
    const activeBots = config.active_bots || [];

    if (tokens.length > 0) {
      console.log(`🔑 Found ${tokens.length} token(s) in DISCORD_BOT_TOKENS`);

      if (tokens.length !== activeBots.length) {
        console.warn(`⚠️  Number of tokens (${tokens.length}) doesn't match number of active_bots (${activeBots.length})`);
        console.warn(`   Using first ${Math.min(tokens.length, activeBots.length)} entries`);
      }

      // Pair tokens with active_bots by index
      for (let i = 0; i < Math.min(tokens.length, activeBots.length); i++) {
        const botName = activeBots[i];
        const bot = config.bots.find((b: any) => b.name === botName);
        if (bot) {
          bot.token = tokens[i];
          console.log(`   ✓ ${botName}: token assigned`);
        } else {
          console.warn(`   ⚠️  Bot "${botName}" not found in config`);
        }
      }
    } else {
      // Fallback to legacy DISCORD_BOT_TOKEN for backwards compatibility
      const legacyToken = process.env.DISCORD_BOT_TOKEN;
      if (legacyToken && activeBots.length > 0) {
        const firstBotName = activeBots[0];
        const bot = config.bots.find((b: any) => b.name === firstBotName);
        if (bot) {
          bot.token = legacyToken;
          console.log(`🔑 Using legacy DISCORD_BOT_TOKEN for ${firstBotName}`);
        }
      }
    }

    return config;
  } catch (err: any) {
    console.warn('⚠️  Could not load config.json, using defaults:', err.message);
    return {
      bots: [{
        name: 'Connectome',
        token: process.env.DISCORD_BOT_TOKEN,
        model: 'claude-sonnet-4-20250514',
        prompt: 'You are Connectome, a helpful AI assistant in Discord.',
        max_tokens: 4096,
        persist_history: true,
        tools: []
      }],
      default_model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      max_conversation_frames: 100,
      max_memory_frames: 200
    };
  }
}

async function main() {
  console.log('🤖 Connectome Discord Bot - Combined Server + Host (Multi-Bot)');
  console.log('==============================================================\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const debugPort = parseInt(args.find(a => a.startsWith('--debug-port='))?.split('=')[1] || '3000');
  const useDebugLLM = args.includes('--debug-llm');

  if (reset) {
    console.log('🔄 Reset flag detected - starting fresh\n');
  }

  // Load Discord config (from env)
  const discordConfig = loadConfig();
  const { botToken, guildId, channelId } = discordConfig;

  // Load bot config (from config.json)
  const botConfig = loadBotConfig();

  // Determine which bots to activate
  let activeBotNames: string[] = [];

  if (botConfig.active_bots && botConfig.active_bots.length > 0) {
    // New multi-bot mode: use active_bots array
    activeBotNames = botConfig.active_bots;
    console.log(`📌 Active bots (from config): ${activeBotNames.join(', ')}`);
  } else if (botConfig.active_bot) {
    // Legacy single-bot mode: use active_bot string
    activeBotNames = [botConfig.active_bot];
    console.log(`📌 Active bot (legacy mode): ${botConfig.active_bot}`);
  } else {
    // Default: use all bots with valid tokens
    activeBotNames = botConfig.bots.filter(b => b.token).map(b => b.name);
    console.log(`📌 Active bots (all with tokens): ${activeBotNames.join(', ') || 'none'}`);
  }

  // Filter to only bots that are active AND have tokens
  const activeBots = botConfig.bots.filter(b =>
    activeBotNames.includes(b.name) && b.token
  );

  // Also include the legacy bot token if no bots have tokens but env var is set
  if (activeBots.length === 0 && botToken) {
    console.log('⚠️  No bots with tokens in config, using DISCORD_BOT_TOKEN from env');
    const defaultBot = botConfig.bots[0] || {
      name: 'Connectome',
      model: botConfig.default_model || 'claude-sonnet-4-20250514',
      prompt: botConfig.default_system_instruction || 'Standard',
      max_tokens: botConfig.max_tokens || 4096
    };
    defaultBot.token = botToken;
    if (guildId) defaultBot.guild_id = guildId;
    if (channelId) defaultBot.auto_join_channels = [channelId];
    activeBots.push(defaultBot);
  }

  if (activeBots.length === 0) {
    console.error('❌ No bots available! Please configure bot tokens in config.json or set DISCORD_BOT_TOKEN');
    process.exit(1);
  }

  console.log(`\n🤖 Starting ${activeBots.length} bot(s):`);
  for (const bot of activeBots) {
    const modelId = bot.model || botConfig.default_model || 'claude-sonnet-4-20250514';
    console.log(`   - ${bot.name}: ${modelId}`);
  }

  // === PHASE 1: Start the AXON Server ===
  console.log('\n📡 Phase 1: Starting AXON Server...');
  console.log(`   HTTP Port: ${discordConfig.httpPort || 8080}`);
  console.log(`   WebSocket Port: ${discordConfig.wsPort || 8081}`);
  console.log(`   Module Port: ${discordConfig.modulePort || 8082}`);

  const server = new CombinedDiscordAxonServer(
    discordConfig.httpPort || 8080,
    discordConfig.wsPort || 8081,
    discordConfig.modulePort || 8082
  );

  await server.init();
  await server.start(activeBots);

  // Give the server a moment to fully initialize
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\n✅ AXON Server is running with multi-bot support');

  // === PHASE 2: Start the ConnectomeHost ===
  console.log('\n🧠 Phase 2: Starting ConnectomeHost...');

  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Create tool-capable LLM providers for each bot (AnthropicToolProvider or BedrockProvider)
  // These are passed directly to ToolLoopAgent, NOT registered with the host
  const botProviders: Map<string, AnthropicToolProvider | BedrockProvider> = new Map();

  for (const bot of activeBots) {
    const modelId = bot.model || botConfig.default_model || 'claude-sonnet-4-20250514';
    const maxTokens = bot.max_tokens || botConfig.max_tokens || 4096;
    const isBedrockModel = modelId.startsWith('bedrock-');

    if (useDebugLLM) {
      console.log(`   ⚠️  Debug LLM mode not supported with ToolLoopAgent for ${bot.name}`);
      continue;
    } else if (isBedrockModel) {
      const provider = new BedrockProvider({
        defaultModel: modelId,
        defaultMaxTokens: maxTokens
      });
      botProviders.set(bot.name, provider);
      console.log(`   ✅ Created BedrockProvider for ${bot.name}: ${modelId}`);
    } else if (apiKey) {
      const provider = new AnthropicToolProvider({
        apiKey,
        defaultModel: modelId,
        defaultMaxTokens: maxTokens
      });
      botProviders.set(bot.name, provider);
      console.log(`   ✅ Created AnthropicToolProvider for ${bot.name}: ${modelId}`);
    } else {
      console.log(`   ⚠️  No ANTHROPIC_API_KEY found for ${bot.name}, skipping`);
    }
  }

  if (botProviders.size === 0) {
    console.error('❌ No LLM providers created! Check your ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  // Create ConnectomeHost (no providers needed - agents use their own)
  const host = new ConnectomeHost({
    persistence: {
      enabled: true,
      storageDir: './discord-host-state',
      snapshotInterval: 5
    },
    debug: {
      enabled: true,
      port: debugPort
    },
    providers: {}, // No providers - agents use their own
    secrets: {
      'discord.token': botToken || activeBots[0]?.token || ''
    },
    reset
  });

  // Create DiscordApplication with ALL bots (multi-bot support)
  // The DiscordApplication sets up infrastructure (one afferent per bot, shared receptors/effectors)
  // But NOT AgentComponent - we use ToolLoopAgent + DiscordAgentEffector instead
  const primaryBot = activeBots[0];
  const primarySystemPrompt = primaryBot.prompt || botConfig.default_system_instruction || 'Standard';

  // Build bot configs for all active bots
  const botConfigsForApp = activeBots.map(bot => ({
    agentName: bot.name,
    botId: bot.name,
    systemPrompt: bot.prompt || botConfig.default_system_instruction || 'Standard',
    token: bot.token || '',
    guild: bot.guild_id || guildId || '',
    autoJoinChannels: (bot.auto_join_channels && bot.auto_join_channels.length > 0)
      ? bot.auto_join_channels
      : (channelId ? [channelId] : [])
  }));

  console.log(`\n📋 Configuring ${botConfigsForApp.length} bot(s) for DiscordApplication`);

  const app = new DiscordApplication({
    agentName: primaryBot.name,
    systemPrompt: primarySystemPrompt,
    llmProviderId: '', // Not used - we bypass AgentComponent
    botToken: primaryBot.token || botToken,
    botId: primaryBot.name,
    skipAgentComponent: true, // Tell DiscordApplication to skip AgentComponent
    bots: botConfigsForApp,   // Multi-bot support: all bots
    discord: {
      host: `localhost:${discordConfig.wsPort || 8081}`,
      guild: primaryBot.guild_id || guildId || '',
      botId: primaryBot.name,
      modulePort: discordConfig.httpPort || 8080,
      autoJoinChannels: (primaryBot.auto_join_channels && primaryBot.auto_join_channels.length > 0) ? primaryBot.auto_join_channels : (channelId ? [channelId] : [])
    },
    maxConversationFrames: botConfig.max_conversation_frames || 100,
    maxMemoryFrames: botConfig.max_memory_frames || 200,
    persistHistory: primaryBot.persist_history ?? true,
    tools: primaryBot.tools || []
  } as any);

  // Start the host application
  try {
    const space = await host.start(app);

    // Get the VEILStateManager from the space
    const veilStateManager = (space as any).veilState as VEILStateManager;
    if (!veilStateManager) {
      throw new Error('VEILStateManager not found in space');
    }

    // Add SpeakerPrefixReceptor to strip XML tags and add speaker prefixes
    // Must be registered BEFORE agent effectors so it intercepts veil:operation events
    const speakerPrefixReceptor = new SpeakerPrefixReceptor();
    space.addComponent(speakerPrefixReceptor, 'speaker-prefix-receptor');
    console.log('✅ Added SpeakerPrefixReceptor for tag stripping');

    // Create ToolLoopAgent + DiscordAgentEffector for each bot
    console.log('\n🤖 Creating ToolLoopAgents for each bot...');
    for (const bot of activeBots) {
      const provider = botProviders.get(bot.name);
      if (!provider) {
        console.log(`   ⚠️  No provider for ${bot.name}, skipping agent creation`);
        continue;
      }

      const systemPrompt = bot.prompt || botConfig.default_system_instruction || 'Standard';

      // Create the ToolLoopAgent with provider passed directly
      const agent = new ToolLoopAgent(
        {
          name: bot.name,
          systemPrompt,
          defaultMaxTokens: bot.max_tokens || botConfig.max_tokens || 4096,
          defaultTemperature: 1.0,
          maxToolRounds: 5,
          tools: [] // Add tools here if needed
        },
        provider,
        veilStateManager
      );

      // Create the DiscordAgentEffector and add it to the space
      const effector = new DiscordAgentEffector(agent, bot.name, bot.name);
      space.addComponent(effector, `agent-effector:${bot.name}`);

      console.log(`   ✅ Created ToolLoopAgent + DiscordAgentEffector for ${bot.name}`);
    }

    console.log('\n🎉 Discord bot is fully running!');
    console.log(`🔧 Debug interface: http://localhost:${debugPort}`);
    console.log(`📋 Bot list: http://localhost:${discordConfig.httpPort || 8080}/bots`);
    console.log('📋 Discord control panel loaded - use actions to manage servers/channels');

    if (useDebugLLM) {
      console.log('\n🧪 Debug LLM mode active - use the debug UI to complete responses manually');
    }

    console.log('\nSend messages in Discord to interact with the bot.');
    console.log('Use the debug interface to view VEIL state and execute control panel actions.\n');

  } catch (error) {
    console.error('❌ Failed to start ConnectomeHost:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
