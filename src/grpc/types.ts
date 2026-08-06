/**
 * Type definitions for Discord AXON gRPC mode
 *
 * Bot identities are discovered from Discord on login, not from static config.
 */

import type { Client } from 'discord.js';
import type { DiscordGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';

/**
 * Bot configuration — discovered from platform + env vars
 *
 * name and userId are populated after Discord login.
 * All cognition fields live in bot-runtime config.
 */
export interface BotConfig {
  name: string;
  /** Canonical agent name from bot-runtime (may differ from Discord display name) */
  agentName?: string;
  token?: string;
  guild_id?: string | null;
}

/**
 * Runtime configuration (from env vars with defaults, tunable via ! commands)
 */
export interface RuntimeConfig {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  /**
   * Per-stream `!mcf` overrides for the server-side activation context render:
   * streamId → (botName or '*' for all bots on the stream) → frame budget.
   * Sent to the server as activation metadata `maxContextFrames`; absent means
   * the server's ACTIVATION_CONTEXT_MAX_FRAMES default applies. In-memory only.
   */
  mcfStreamOverrides: Record<string, Record<string, number>>;
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
  /** Map from Discord userId to bot name — managed bots only (populated on login) */
  botUserIdToName: Map<string, string>;
  /** Track activations currently being processed (dedup) */
  processingActivations: Set<string>;
  /** Track bot-to-bot interaction counts per stream */
  botInteractionCounts: Map<string, number>;
  /** Runtime configuration */
  runtimeConfig: RuntimeConfig;
}
