/**
 * Bot instance management for Discord AXON gRPC mode
 * Handles creation and setup of individual bot instances
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { DiscordGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import { ToolLoopAgent, createFetchTool } from '../tool-loop-agent.js';
import type { ToolHandler } from '../tool-loop-agent.js';
import { AnthropicToolProvider } from '../anthropic-tool-provider.js';
import { BedrockProvider } from '../bedrock-provider.js';
import { cleanSpeechContent, splitMessage } from './utils/index.js';
import type { BotConfig, BotInstance, SharedState } from './types.js';
import type { MCPManager } from '@connectome/grpc-common';

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
 * Create LLM provider based on model name
 */
function createLlmProvider(
  modelName: string,
  maxTokens: number
): AnthropicToolProvider | BedrockProvider | undefined {
  // Check for bedrock- prefix (config format) or us./eu. prefixes (AWS region format)
  const isBedrockModel = modelName.startsWith('bedrock-') ||
                         modelName.startsWith('us.') ||
                         modelName.startsWith('eu.');

  if (isBedrockModel) {
    return new BedrockProvider({
      region: process.env.AWS_REGION || 'us-east-1',
      defaultModel: modelName,
      defaultMaxTokens: maxTokens
    });
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      return new AnthropicToolProvider({
        apiKey,
        defaultModel: modelName,
        defaultMaxTokens: maxTokens
      });
    }
  }

  return undefined;
}

/**
 * Create a bot instance (without connecting)
 */
export function createBotInstance(
  botConfig: BotConfig,
  grpcHost: string,
  grpcPort: number,
  guildId?: string,
  mcpManager?: MCPManager
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
    streamManager
  };

  // Create LLM provider and ToolLoopAgent
  const modelName = botConfig.model || 'claude-sonnet-4-20250514';
  const maxTokens = botConfig.max_tokens || 1024;
  const llmProvider = createLlmProvider(modelName, maxTokens);

  if (llmProvider) {
    botInstance.llmProvider = llmProvider;

    // Use exact same prompt logic as non-gRPC version
    const systemPrompt = botConfig.prompt || 'Standard';

    // Build tools list from config (matching non-gRPC combined-start.ts behavior)
    const agentTools: ToolHandler[] = [];
    if (botConfig.tools?.includes('fetch')) {
      agentTools.push(createFetchTool());
      console.log(`  🔧 ${botConfig.name}: fetch tool enabled`);
    }

    // Add MCP tools if configured
    if (mcpManager && botConfig.mcp && botConfig.mcp.length > 0) {
      const mcpTools = mcpManager.getToolHandlersForServers(botConfig.mcp);
      agentTools.push(...mcpTools);
      console.log(`  🔌 ${botConfig.name}: ${mcpTools.length} MCP tool(s) from [${botConfig.mcp.join(', ')}]`);
    }

    // Pass a stub object - ToolLoopAgent stores veilStateManager but never uses it
    const dummyVeilState = {} as any;
    botInstance.agent = new ToolLoopAgent(
      {
        name: botConfig.name,
        systemPrompt,
        defaultMaxTokens: maxTokens,
        tools: agentTools
      },
      llmProvider,
      dummyVeilState
    );
    console.log(`  Created ToolLoopAgent for ${botConfig.name} (${modelName})`);
  } else {
    console.warn(`  No LLM provider for ${botConfig.name} - agent responses disabled`);
  }

  return botInstance;
}

/**
 * Set up speech handler for a bot (handles server-generated speech)
 */
export function setupSpeechHandler(
  bot: BotInstance,
  allBotNames: string[]
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
        const chunks = splitMessage(cleanedContent, 2000);
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
