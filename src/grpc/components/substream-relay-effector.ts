/**
 * SubstreamRelayEffector - Relays speech/action facets from substreams
 * back to the originating Discord channel.
 *
 * When a bot-runtime enters a substream, it creates a stream
 * (ID prefix `substream:`) with a parentStreamId linking back to the
 * originating Discord channel stream. This effector:
 *
 * 1. Subscribes to ALL streams for speech + action facets
 * 2. Filters for facets whose streamId starts with `substream:`
 * 3. Resolves the parent stream -> Discord channel
 * 4. Sends formatted relay messages showing substream progress
 *
 * Message format:
 *   Speech: > **[substream:nanogpt-training]** opus-4.6: <content split across messages>
 *   Action: > **[substream:nanogpt-training]** opus-4.6 -> @terminal
 */

import type { Client } from 'discord.js';
import type { DiscordGrpcClient } from '../client.js';
import type { SharedState } from '../types.js';
import { splitMessage } from '../utils/index.js';

export interface SubstreamRelayEffectorConfig {
  /** Shared state with all bot instances */
  state: SharedState;
  /** Max characters for relayed speech content */
  maxRelayContentLength?: number;
  /** Debounce window in ms for per-turn speech (relay last one in window) */
  debounceWindowMs?: number;
}

/** Cached info about a substream's parent channel */
interface SubstreamParentInfo {
  parentStreamId: string;
  channelId: string;
  guildId?: string;
  /** Bot that created/owns this substream — preferred for relay delivery */
  ownerAgent?: string;
}

/**
 * SubstreamRelayEffector - Relays substream progress to Discord channels
 */
export class SubstreamRelayEffector {
  private state: SharedState;
  private maxRelayContentLength: number;
  private debounceWindowMs: number;
  private unsubscribe?: () => void;

  /** Cache: substreamId -> null (lookup failed, don't retry for a while) */
  private failedLookups: Map<string, number> = new Map();

  /** Debounce timers for per-turn speech: substreamId -> pending message */
  private pendingSpeech: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    content: string;
    agentName: string;
    substreamId: string;
    attachments?: any[];
  }> = new Map();

  constructor(config: SubstreamRelayEffectorConfig) {
    this.state = config.state;
    this.maxRelayContentLength = config.maxRelayContentLength ?? 0; // 0 = unlimited
    this.debounceWindowMs = config.debounceWindowMs ?? 1500;
  }

  /**
   * Start the substream relay.
   * Uses the first available bot's gRPC client to subscribe.
   * Must be called after at least one bot is connected.
   */
  setup(): void {
    const bot = this.getFirstBot();
    if (!bot) {
      console.warn('[SubstreamRelay] No bots available yet, deferring setup');
      return;
    }

    // Subscribe to ALL streams for speech + action facets
    // We filter for substream: prefix in the callback
    this.unsubscribe = bot.grpcClient.subscribeToStreamDeltas(
      (facet) => this.handleFacet(facet),
      { streamIds: [] }  // empty = all streams
    );

    console.log('[SubstreamRelay] Subscribed to all streams for substream relay');
  }

  /**
   * Tear down subscriptions
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    // Clear pending debounce timers
    for (const [, pending] of this.pendingSpeech) {
      clearTimeout(pending.timer);
    }
    this.pendingSpeech.clear();
  }

  /**
   * Handle an incoming facet from the subscription
   */
  private handleFacet(facet: any): void {
    const streamId: string = facet.streamId || '';
    if (!streamId.startsWith('substream:')) return;

    if (facet.type === 'speech') {
      this.handleSubstreamSpeech(facet, streamId);
    } else if (facet.type === 'action') {
      this.handleSubstreamAction(facet, streamId);
    }
  }

  /**
   * Handle a speech facet from a substream.
   * Debounces per-turn speech to avoid rapid-fire messages.
   */
  private handleSubstreamSpeech(facet: any, substreamId: string): void {
    const content = facet.content || '';
    const attachments: any[] | undefined = facet.attachments?.length ? facet.attachments : undefined;
    if (!content && !attachments) return;

    // Skip relayed user messages — these are parent-channel messages echoed into
    // the substream by bot-runtime's activation redirect. Relaying them back to
    // Discord creates a feedback loop (Discord message → activation → relay to
    // substream → relay effector → Discord message → activation → ...).
    if (facet.agentId === 'relay' || facet.state?.sourceStreamId) return;

    const agentName = facet.agentName || facet.agentId || 'unknown';
    const isCyclePending = facet.state?.cyclePending === true;

    // Attachments bypass debounce — send immediately (they're infrequent and
    // need to arrive with the speech that references them)
    if (attachments) {
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingSpeech.delete(substreamId);
      }
      this.relaySpeech(substreamId, agentName, content, attachments);
      return;
    }

    if (isCyclePending) {
      // Per-turn speech: debounce — only relay the last one in the window
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const timer = setTimeout(() => {
        this.pendingSpeech.delete(substreamId);
        this.relaySpeech(substreamId, agentName, content);
      }, this.debounceWindowMs);

      this.pendingSpeech.set(substreamId, {
        timer,
        content,
        agentName,
        substreamId,
      });
    } else {
      // Final speech: cancel any pending debounce and send immediately
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingSpeech.delete(substreamId);
      }
      this.relaySpeech(substreamId, agentName, content);
    }
  }

  /**
   * Handle an action facet from a substream.
   * Always relay immediately (actions are infrequent).
   */
  private handleSubstreamAction(facet: any, substreamId: string): void {
    const agentName = facet.agentName || facet.agentId || 'unknown';
    const toolName = facet.state?.toolName || 'unknown-tool';

    this.relayAction(substreamId, agentName, toolName);
  }

  /**
   * Relay a speech message to the parent Discord channel
   */
  private async relaySpeech(
    substreamId: string,
    agentName: string,
    content: string,
    attachments?: any[]
  ): Promise<void> {
    const parentInfo = await this.resolveParentChannel(substreamId);
    if (!parentInfo) return;

    // Build Discord file objects from attachments
    const files: Array<{ attachment: Buffer; name: string }> = [];
    if (attachments?.length) {
      for (const att of attachments) {
        const buffer = att.data instanceof Uint8Array
          ? Buffer.from(att.data)
          : Buffer.from(att.data, 'base64');
        files.push({ attachment: buffer, name: att.filename || 'attachment' });
      }
    }

    // Clean up: collapse multiple newlines, strip leading/trailing whitespace
    let cleaned = content.replace(/\n{3,}/g, '\n\n').trim();

    // Apply configurable content limit (0 = unlimited)
    if (this.maxRelayContentLength > 0 && cleaned.length > this.maxRelayContentLength) {
      cleaned = cleaned.substring(0, this.maxRelayContentLength) + '...';
    }

    // Split content across multiple Discord messages (2000 char limit each).
    // First chunk gets the substream prefix; subsequent chunks are plain.
    const prefix = `> **[${substreamId}]** ${agentName}: `;
    const firstChunkMax = 2000 - prefix.length;

    if (!cleaned && files.length > 0) {
      // Attachment-only relay
      await this.sendToChannel(parentInfo, prefix, agentName, files);
    } else if (cleaned.length <= firstChunkMax) {
      // Fits in one message with prefix
      await this.sendToChannel(parentInfo, prefix + cleaned, agentName, files);
    } else {
      // Multi-part: first chunk sized to fit the prefix, rest split at 2000
      const firstPart = cleaned.substring(0, firstChunkMax);
      const rest = cleaned.substring(firstChunkMax);
      const restChunks = rest ? splitMessage(rest, 2000) : [];

      await this.sendToChannel(parentInfo, prefix + firstPart, agentName, files);
      for (const chunk of restChunks) {
        await this.sendToChannel(parentInfo, chunk, agentName);
      }
    }
  }

  /**
   * Relay an action notification to the parent Discord channel
   */
  private async relayAction(
    substreamId: string,
    agentName: string,
    toolName: string
  ): Promise<void> {
    const parentInfo = await this.resolveParentChannel(substreamId);
    if (!parentInfo) return;

    const message = `> **[${substreamId}]** ${agentName} \u2192 @${toolName}`;

    await this.sendToChannel(parentInfo, message, agentName);
  }

  /**
   * Resolve a substream's parent Discord channel.
   * Caches results to avoid repeated lookups.
   */
  private async resolveParentChannel(
    substreamId: string
  ): Promise<SubstreamParentInfo | null> {
    // Check if we recently failed to look this up (retry after 10s)
    const failedAt = this.failedLookups.get(substreamId);
    if (failedAt && Date.now() - failedAt < 10_000) {
      return null;
    }

    // Query the server for stream info
    const bot = this.getFirstBot();
    if (!bot) return null;

    try {
      const streamInfo = await bot.grpcClient.getStreamInfo(substreamId);
      if (!streamInfo || !streamInfo.parentId) {
        console.warn(`[SubstreamRelay] No parent stream found for ${substreamId}`);
        this.failedLookups.set(substreamId, Date.now());
        return null;
      }

      // Parse parent stream ID to extract channelId and guildId
      // Discord stream IDs: discord:<guildId>:<channelId> or discord:dm:<channelId>
      const parentStreamId = streamInfo.parentId;
      const channelInfo = this.parseDiscordStreamId(parentStreamId);
      if (!channelInfo) {
        // Parent is on another platform (e.g. Signal) — not our concern
        this.failedLookups.set(substreamId, Date.now());
        return null;
      }

      const info: SubstreamParentInfo = {
        parentStreamId,
        channelId: channelInfo.channelId,
        guildId: channelInfo.guildId,
        ownerAgent: streamInfo.metadata?.createdBy || streamInfo.metadata?.participants,
      };

      console.log(`[SubstreamRelay] Resolved ${substreamId} -> channel ${channelInfo.channelId}`);
      return info;
    } catch (error: any) {
      console.error(`[SubstreamRelay] Failed to resolve parent for ${substreamId}: ${error.message}`);
      this.failedLookups.set(substreamId, Date.now());
      return null;
    }
  }

  /**
   * Parse a Discord stream ID into channelId and optional guildId.
   * Formats: discord:<guildId>:<channelId> or discord:dm:<channelId>
   */
  private parseDiscordStreamId(streamId: string): { channelId: string; guildId?: string } | null {
    if (!streamId.startsWith('discord:')) return null;

    const parts = streamId.split(':');
    if (parts.length === 3 && parts[1] === 'dm') {
      // discord:dm:<channelId>
      return { channelId: parts[2] };
    } else if (parts.length === 3) {
      // discord:<guildId>:<channelId>
      return { channelId: parts[2], guildId: parts[1] };
    }

    return null;
  }

  /**
   * Send a message to a Discord channel.
   * Tries to use the bot matching agentName, then the substream owner, then any available bot.
   */
  private async sendToChannel(
    parentInfo: SubstreamParentInfo,
    content: string,
    agentName?: string,
    files?: Array<{ attachment: Buffer; name: string }>
  ): Promise<void> {
    const channelId = parentInfo.channelId;
    const bot = this.getBotByAgent(agentName) || this.getBotByAgent(parentInfo.ownerAgent) || this.getFirstBot();
    if (!bot) {
      console.warn('[SubstreamRelay] No bots available to send relay message');
      return;
    }

    try {
      const channel = await bot.discord.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        if (files?.length) {
          // Send with attachments
          await channel.send({
            ...(content ? { content } : {}),
            files,
          });
          console.log(`[SubstreamRelay] Relayed ${files.length} attachment(s) to ${channelId}`);
        } else if (content) {
          await channel.send(content);
        }
      } else {
        console.warn(`[SubstreamRelay] Channel ${channelId} not found or not sendable`);
      }
    } catch (error: any) {
      console.error(`[SubstreamRelay] Failed to send relay to ${channelId}: ${error.message}`);
    }
  }

  /**
   * Find a bot instance by its canonical agentName (e.g. "claude-opus-4-6").
   */
  private getBotByAgent(agentName?: string): { grpcClient: DiscordGrpcClient; discord: Client } | null {
    if (!agentName) return null;
    for (const [, bot] of this.state.bots) {
      if (bot.config.agentName === agentName) return bot;
    }
    return null;
  }

  /**
   * Get the first available bot instance (for gRPC queries).
   */
  private getFirstBot(): { grpcClient: DiscordGrpcClient; discord: Client } | null {
    for (const [, bot] of this.state.bots) {
      if (bot.grpcClient.isConnected()) {
        return bot;
      }
    }
    const first = this.state.bots.values().next();
    if (!first.done) {
      return first.value;
    }
    return null;
  }
}
