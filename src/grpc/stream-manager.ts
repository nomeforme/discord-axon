/**
 * Stream Manager for Discord gRPC Client
 * Manages subscriptions and stream state for Discord channels
 */

import { DiscordGrpcClient } from './client.js';
import { EventEmitter } from 'events';

/**
 * Stream information
 */
export interface StreamInfo {
  streamId: string;
  channelId: string;
  channelName?: string;
  channelType: 'text' | 'voice' | 'dm' | 'thread';
  guildId?: string;
  guildName?: string;
  createdAt: number;
  lastMessageAt: number;
}

/**
 * Manages streams and subscriptions for Discord channels
 */
export class StreamManager extends EventEmitter {
  private client: DiscordGrpcClient;
  private streams: Map<string, StreamInfo> = new Map();
  private unsubscribes: Map<string, () => void> = new Map();
  private speechCallback?: (facet: any, streamInfo: StreamInfo) => void;
  private actionCallback?: (facet: any, streamInfo: StreamInfo) => void;

  constructor(client: DiscordGrpcClient) {
    super();
    this.client = client;
  }

  /**
   * Register a callback for speech facets
   */
  onSpeech(callback: (facet: any, streamInfo: StreamInfo) => void): void {
    this.speechCallback = callback;
  }

  /**
   * Register a callback for action facets
   */
  onAction(callback: (facet: any, streamInfo: StreamInfo) => void): void {
    this.actionCallback = callback;
  }

  /**
   * Get or create a stream for a channel
   */
  async getOrCreateStream(
    channelId: string,
    metadata: {
      channelName?: string;
      channelType?: 'text' | 'voice' | 'dm' | 'thread';
      guildId?: string;
      guildName?: string;
      parentStreamId?: string;
    }
  ): Promise<StreamInfo> {
    const streamId = this.buildStreamId(channelId, metadata.guildId);

    // Check if stream already exists locally
    let info = this.streams.get(streamId);
    if (info) {
      // If parent linkage is provided, ensure the server knows about it
      // (stream may have been created before hierarchy support was deployed)
      if (metadata.parentStreamId) {
        this.client.ensureStream(channelId, metadata).catch(() => {});
      }
      // Update last message time
      info.lastMessageAt = Date.now();
      return info;
    }

    // Create new stream on server
    await this.client.ensureStream(channelId, metadata);

    // Store stream info locally
    info = {
      streamId,
      channelId,
      channelName: metadata.channelName,
      channelType: metadata.channelType || 'text',
      guildId: metadata.guildId,
      guildName: metadata.guildName,
      createdAt: Date.now(),
      lastMessageAt: Date.now()
    };

    this.streams.set(streamId, info);

    // Subscribe to speech and actions for this stream
    this.subscribeToStream(streamId);

    console.log(`[StreamManager] Created stream: ${streamId} (${metadata.channelName || channelId})`);

    return info;
  }

  /**
   * Build stream ID from channel metadata
   */
  private buildStreamId(channelId: string, guildId?: string): string {
    if (guildId) {
      return `discord:${guildId}:${channelId}`;
    }
    return `discord:dm:${channelId}`;
  }

  /**
   * Subscribe to a specific stream
   */
  private subscribeToStream(streamId: string): void {
    // Avoid duplicate subscriptions
    if (this.unsubscribes.has(streamId)) {
      return;
    }

    // Single combined subscription for both speech and actions (reduces gRPC stream count by 50%)
    const unsub = this.client.subscribeToStreamDeltas(
      (facet) => {
        const info = this.streams.get(streamId);
        if (!info) return;

        if (facet.type === 'speech') {
          if (this.speechCallback) this.speechCallback(facet, info);
          this.emit('speech', facet, info);
        } else if (facet.type === 'action') {
          if (this.actionCallback) this.actionCallback(facet, info);
          this.emit('action', facet, info);
        }
      },
      { streamIds: [streamId] }
    );

    this.unsubscribes.set(streamId, unsub);
  }

  /**
   * Get stream by ID
   */
  getStream(streamId: string): StreamInfo | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get stream for a channel
   */
  getStreamByChannelId(channelId: string, guildId?: string): StreamInfo | undefined {
    const streamId = this.buildStreamId(channelId, guildId);
    return this.streams.get(streamId);
  }

  /**
   * Get all active streams
   */
  getAllStreams(): StreamInfo[] {
    return Array.from(this.streams.values());
  }

  /**
   * Get streams for a specific guild
   */
  getStreamsForGuild(guildId: string): StreamInfo[] {
    return this.getAllStreams().filter(s => s.guildId === guildId);
  }

  /**
   * Clean up inactive streams
   */
  cleanupInactiveStreams(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const [streamId, info] of this.streams) {
      if (info.lastMessageAt < cutoff) {
        // Unsubscribe
        const unsub = this.unsubscribes.get(streamId);
        if (unsub) {
          unsub();
          this.unsubscribes.delete(streamId);
        }

        // Remove stream
        this.streams.delete(streamId);
        cleaned++;

        console.log(`[StreamManager] Cleaned up inactive stream: ${streamId}`);
      }
    }

    return cleaned;
  }

  /**
   * Unsubscribe from all streams
   */
  unsubscribeAll(): void {
    for (const [streamId, unsub] of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes.clear();
  }

  /**
   * Get stats
   */
  getStats(): {
    totalStreams: number;
    guildStreams: number;
    dmStreams: number;
    activeSubscriptions: number;
  } {
    const streams = this.getAllStreams();
    return {
      totalStreams: streams.length,
      guildStreams: streams.filter(s => s.guildId).length,
      dmStreams: streams.filter(s => !s.guildId).length,
      activeSubscriptions: this.unsubscribes.size
    };
  }
}
