/**
 * Type definitions for Discord AXON gRPC mode
 */

import type { Client } from 'discord.js';
import type { DiscordGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';
import type { MCPServerConfig } from '@connectome/grpc-common';

/**
 * Bot configuration from config.json
 */
export interface BotConfig {
  name: string;
  token?: string;
  model?: string;
  prompt?: string;
  /** Skip the platform identity text in system prompt (bot gets only the custom prompt, or nothing if prompt is "Standard") */
  skip_identity_prompt?: boolean;
  max_tokens?: number;
  tools?: string[];
  /** List of MCP server names this bot should use */
  mcp?: string[];
  /** Enable prompt caching (default true). Set false for bedrock cross-region models. */
  prompt_caching?: boolean;
  guild_id?: string | null;
  auto_join_channels?: string[];
  /** Paths to skill directories to load */
  skill_paths?: string[];
  /** Remote mode: discord-axon keeps Discord connection but delegates cognition to external bot-runtime */
  remote?: boolean;
  /** RLM (recursive sub-agent) configuration */
  rlm?: {
    maxDepth?: number;
    maxCalls?: number;
    budget?: number;
    timeoutSeconds?: number;
    model?: string;
    childModel?: string;
    cwd?: string;
  };
}

/**
 * Discord configuration from config.json
 */
export interface DiscordConfig {
  active_bots: string[];
  bots: BotConfig[];
  /** Global MCP server configurations */
  mcp_servers?: MCPServerConfig[];
  max_conversation_frames?: number;
  max_bot_mentions_per_conversation?: number;
  random_reply_chance?: number;
  max_message_length?: number;
}

/**
 * Runtime configuration for commands (shared across all bots)
 */
export interface RuntimeConfig {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
}

/**
 * Runtime bot instance
 */
export interface BotInstance {
  config: BotConfig;
  discord: Client;
  grpcClient: DiscordGrpcClient;
  streamManager: StreamManager;
  userId?: string;
  /** Active typing intervals for remote bot activations, keyed by streamId */
  activeTypingIntervals?: Map<string, ReturnType<typeof setInterval>>;
}

/**
 * Shared state across all bot instances
 */
export interface SharedState {
  /** Map from bot name to bot instance */
  bots: Map<string, BotInstance>;
  /** Map from Discord userId to bot name (for mention-based routing) */
  botUserIdToName: Map<string, string>;
  /** Track activations currently being processed (dedup) */
  processingActivations: Set<string>;
  /** Track bot-to-bot interaction counts per stream */
  botInteractionCounts: Map<string, number>;
  /** Runtime configuration */
  runtimeConfig: RuntimeConfig;
  /** All paired bot configs (for iteration) */
  pairedBots: BotConfig[];
}
