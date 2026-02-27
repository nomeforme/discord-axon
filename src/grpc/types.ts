/**
 * Type definitions for Discord AXON gRPC mode
 */

import type { Client } from 'discord.js';
import type { DiscordGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';

/**
 * Bot configuration from config.json
 *
 * All cognition fields (model, tools, mcp, skills, rlm, etc.) live in
 * bot-runtime/config.json. The axon only needs identity + platform binding.
 */
export interface BotConfig {
  name: string;
  token?: string;
  prompt?: string;
  /** Skip the platform identity text in system prompt */
  skip_identity_prompt?: boolean;
  guild_id?: string | null;
  auto_join_channels?: string[];
  /** Remote mode: cognition delegated to bot-runtime (all bots are remote) */
  remote?: boolean;
}

/**
 * Discord configuration from config.json
 */
export interface DiscordConfig {
  active_bots: string[];
  bots: BotConfig[];
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
