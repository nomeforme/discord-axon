/**
 * DiscordSpeechEffector - Handles server-generated speech and actions
 *
 * Subscribes to speech and action facets from the Connectome server
 * and sends them to Discord:
 * - Speech facets → Discord messages
 * - Action facets → Discord reactions, embeds, etc.
 *
 * Each managed bot delivers only its own speech. Unmanaged agents
 * (exogenous bots) handle their own platform delivery.
 */

import type { Client, Guild, TextChannel } from 'discord.js';
import { cleanSpeechContent, resolveMentions, splitMessage } from '../utils/index.js';
import type { StreamManager, StreamInfo } from '../stream-manager.js';
import type { BotConfig } from '../types.js';

export interface DiscordSpeechEffectorConfig {
  botConfig: BotConfig;
  discordClient: Client;
  streamManager: StreamManager;
  /** Set of bot names managed by this axon (discovered on login) */
  managedBotNames: Set<string>;
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
  private managedBotNames: Set<string>;
  private maxMessageLength?: number;
  private botUserIdToName: Map<string, string>;
  private activeTypingIntervals?: Map<string, ReturnType<typeof setInterval>>;

  constructor(config: DiscordSpeechEffectorConfig) {
    this.botConfig = config.botConfig;
    this.discordClient = config.discordClient;
    this.streamManager = config.streamManager;
    this.managedBotNames = config.managedBotNames;
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
    this.streamManager.onSpeech(async (facet, streamInfo) => {
      await this.handleSpeech(facet, streamInfo);
    });
  }

  /**
   * Handle speech facet from server
   *
   * Each managed bot delivers only its own speech.
   * If the speaker is another managed bot, that bot's effector handles it.
   * If the speaker is an unmanaged agent (exogenous), it has its own platform client.
   */
  private async handleSpeech(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;

    // Determine speaker identity
    const speakerName = facet.agentName || facet.agentId || '';

    // Only deliver speech that matches THIS bot's name (or agentName from binding)
    const agentName = this.botConfig.agentName;
    const isMyBot = speakerName === botName || facet.agentName === botName
      || (agentName && (speakerName === agentName || facet.agentName === agentName));
    if (!isMyBot) {
      return;
    }

    console.log(`[DiscordSpeechEffector:${botName}] Sending message to ${streamInfo.channelName || streamInfo.channelId}`);

    try {
      // Clean speech content (strip XML tags, extract tool syntax)
      let cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent && !facet.attachments?.length) return;

      const channel = await this.discordClient.channels.fetch(streamInfo.channelId);
      if (channel && 'send' in channel) {
        // Resolve @mentions for outgoing speech
        if ('guild' in channel) {
          cleanedContent = await resolveMentions(cleanedContent, (channel as TextChannel).guild, this.botUserIdToName);
        }

        // Build file attachments from facet
        const files: Array<{ attachment: Buffer; name: string }> = [];
        if (facet.attachments?.length) {
          for (const att of facet.attachments) {
            const buffer = att.data instanceof Uint8Array
              ? Buffer.from(att.data)
              : Buffer.from(att.data, 'base64');
            files.push({ attachment: buffer, name: att.filename || 'attachment' });
          }
        }

        // Split if too long — attach files to first chunk only
        const chunks = cleanedContent ? splitMessage(cleanedContent, this.maxMessageLength) : [];
        if (chunks.length === 0 && files.length > 0) {
          // Attachment-only message (no text)
          await channel.send({ files });
        } else {
          for (let i = 0; i < chunks.length; i++) {
            if (i === 0 && files.length > 0) {
              await channel.send({ content: chunks[i], files });
            } else {
              await channel.send(chunks[i]);
            }
          }
        }
        console.log(`[DiscordSpeechEffector:${botName}] Sent ${chunks.length || (files.length > 0 ? 1 : 0)} chunk(s)${files.length > 0 ? ` with ${files.length} attachment(s)` : ''}`);

        // Typing indicator: clear on final speech, restart on per-turn (cycle still running)
        // cyclePending lives in facet.state (serialized through gRPC stateJson)
        if (facet.state?.cyclePending && this.activeTypingIntervals?.has(streamInfo.streamId)) {
          // Per-turn speech — cycle is still running, restart typing
          if ('sendTyping' in channel) {
            channel.sendTyping().catch(() => {});
          }
        } else {
          // Final speech or cycle complete — clear typing
          const typingInterval = this.activeTypingIntervals?.get(streamInfo.streamId);
          if (typingInterval) {
            clearInterval(typingInterval);
            this.activeTypingIntervals?.delete(streamInfo.streamId);
          }
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
