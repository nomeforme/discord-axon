/**
 * DiscordSpeechEffector - Handles server-generated speech and actions
 *
 * Subscribes to speech and action facets from the Connectome server
 * and sends them to Discord:
 * - Speech facets → Discord messages
 * - Action facets → Discord reactions, embeds, etc.
 *
 * This handles server-initiated output (vs DiscordAgentEffector which
 * handles client-side agent execution).
 */

import type { Client, Guild, TextChannel } from 'discord.js';
import { cleanSpeechContent, resolveMentions, splitMessage } from '../utils/index.js';
import type { StreamManager, StreamInfo } from '../stream-manager.js';
import type { BotConfig } from '../types.js';

export interface DiscordSpeechEffectorConfig {
  botConfig: BotConfig;
  discordClient: Client;
  streamManager: StreamManager;
  allBotNames: string[];
  remoteBotNames: string[];
  maxMessageLength?: number;
  botUserIdToName: Map<string, string>;
  activeTypingIntervals?: Map<string, ReturnType<typeof setInterval>>;
}

/**
 * DiscordSpeechEffector - Sends server-generated speech to Discord
 *
 * Constraint equivalent: EFFECTOR priority (produces side effects)
 */
export class DiscordSpeechEffector {
  private botConfig: BotConfig;
  private discordClient: Client;
  private streamManager: StreamManager;
  private allBotNames: string[];
  private remoteBotNames: string[];
  private maxMessageLength?: number;
  private botUserIdToName: Map<string, string>;
  private activeTypingIntervals?: Map<string, ReturnType<typeof setInterval>>;

  constructor(config: DiscordSpeechEffectorConfig) {
    this.botConfig = config.botConfig;
    this.discordClient = config.discordClient;
    this.streamManager = config.streamManager;
    this.allBotNames = config.allBotNames;
    this.remoteBotNames = config.remoteBotNames;
    this.maxMessageLength = config.maxMessageLength;
    this.botUserIdToName = config.botUserIdToName;
    this.activeTypingIntervals = config.activeTypingIntervals;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.botConfig.name;
  }

  /**
   * Set up subscriptions to server facets
   */
  setup(): void {
    this.setupSpeechHandler();
    this.setupActionHandler();
    console.log(`[DiscordSpeechEffector:${this.botConfig.name}] Handlers registered`);
  }

  /**
   * Set up speech handler (handles server-generated speech)
   */
  private setupSpeechHandler(): void {
    const botName = this.botConfig.name;

    this.streamManager.onSpeech(async (facet, streamInfo) => {
      await this.handleSpeech(facet, streamInfo);
    });
  }

  /**
   * Handle speech facet from server
   */
  private async handleSpeech(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;

    // Determine speaker identity
    const speakerName = facet.agentName || facet.agentId || '';
    const isFromOurBot = this.allBotNames.includes(speakerName) || this.allBotNames.includes(facet.agentId || '') || this.allBotNames.includes(facet.agentName || '');
    const isRemote = this.remoteBotNames.includes(speakerName) || this.remoteBotNames.includes(facet.agentId || '') || this.remoteBotNames.includes(facet.agentName || '');

    // Skip speech from LOCAL bots (they send directly to Discord via DiscordAgentEffector)
    if (isFromOurBot && !isRemote) {
      return;
    }

    // For remote bot speech, only THIS bot's effector should deliver (avoid duplicates from other bots)
    if (isRemote && speakerName !== botName && facet.agentName !== botName) {
      return;
    }

    console.log(`[DiscordSpeechEffector:${botName}] Sending message to ${streamInfo.channelName || streamInfo.channelId}${isRemote ? ` (remote bot: ${speakerName})` : ''}`);

    try {
      // Clean speech content (strip XML tags, extract tool syntax)
      let cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent) return;

      const channel = await this.discordClient.channels.fetch(streamInfo.channelId);
      if (channel && 'send' in channel) {
        // Resolve @mentions for remote bot speech
        if ('guild' in channel) {
          cleanedContent = await resolveMentions(cleanedContent, (channel as TextChannel).guild, this.botUserIdToName);
        }

        // Split if too long
        const chunks = splitMessage(cleanedContent, this.maxMessageLength);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
        console.log(`[DiscordSpeechEffector:${botName}] Sent ${chunks.length} chunk(s)`);

        // Clear typing indicator for this stream
        const typingInterval = this.activeTypingIntervals?.get(streamInfo.streamId);
        if (typingInterval) {
          clearInterval(typingInterval);
          this.activeTypingIntervals?.delete(streamInfo.streamId);
        }
      }
    } catch (error: any) {
      console.error(`[DiscordSpeechEffector:${botName}] Error sending message:`, error.message);
    }
  }

  /**
   * Set up action handler
   */
  private setupActionHandler(): void {
    const botName = this.botConfig.name;

    this.streamManager.onAction(async (facet, streamInfo) => {
      await this.handleAction(facet, streamInfo);
    });
  }

  /**
   * Handle action facet from server
   */
  private async handleAction(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;
    const action = facet.state;

    console.log(`[DiscordSpeechEffector:${botName}] Executing action: ${action?.toolName}`);

    try {
      switch (action?.toolName) {
        case 'addReaction':
          await this.executeAddReaction(action, streamInfo);
          break;

        case 'sendEmbed':
          await this.executeSendEmbed(action, streamInfo);
          break;

        default:
          console.log(`[DiscordSpeechEffector:${botName}] Unknown action type: ${action?.toolName}`);
      }
    } catch (error: any) {
      console.error(`[DiscordSpeechEffector:${botName}] Error executing action:`, error.message);
    }
  }

  /**
   * Execute addReaction action
   */
  private async executeAddReaction(action: any, streamInfo: StreamInfo): Promise<void> {
    const { messageId, emoji } = action.parameters || {};
    if (!messageId || !emoji) {
      console.warn(`[DiscordSpeechEffector:${this.botConfig.name}] addReaction missing messageId or emoji`);
      return;
    }

    try {
      const channel = await this.discordClient.channels.fetch(streamInfo.channelId);
      if (channel && 'messages' in channel) {
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
        console.log(`[DiscordSpeechEffector:${this.botConfig.name}] Added reaction ${emoji} to message ${messageId}`);
      }
    } catch (error: any) {
      console.error(`[DiscordSpeechEffector:${this.botConfig.name}] Failed to add reaction:`, error.message);
    }
  }

  /**
   * Execute sendEmbed action
   */
  private async executeSendEmbed(action: any, streamInfo: StreamInfo): Promise<void> {
    const { embed } = action.parameters || {};
    if (!embed) {
      console.warn(`[DiscordSpeechEffector:${this.botConfig.name}] sendEmbed missing embed data`);
      return;
    }

    try {
      const channel = await this.discordClient.channels.fetch(streamInfo.channelId);
      if (channel && 'send' in channel) {
        await channel.send({ embeds: [embed] });
        console.log(`[DiscordSpeechEffector:${this.botConfig.name}] Sent embed to channel ${streamInfo.channelId}`);
      }
    } catch (error: any) {
      console.error(`[DiscordSpeechEffector:${this.botConfig.name}] Failed to send embed:`, error.message);
    }
  }
}
