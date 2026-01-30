/**
 * DiscordMessageReceptor - gRPC equivalent of the non-gRPC DiscordMessageReceptor
 *
 * Handles Discord message events and routes them appropriately:
 * - Emits messages to Connectome server as facets
 * - Routes mentions/replies to appropriate bots
 * - Handles bot-to-bot interaction limits
 * - Triggers agent activation for relevant messages
 *
 * This is the gRPC client-side equivalent - it doesn't extend Component
 * since it runs in the client, not the server's Space.
 */

import type { Message } from 'discord.js';
import { messageDeduplicator } from '../../message-deduplicator.js';
import { getUserNameCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig } from '../types.js';
import type { DiscordAgentEffector } from './discord-agent-effector.js';
import type { DiscordCommandEffector } from './discord-command-effector.js';

export interface DiscordMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
  agentEffector: DiscordAgentEffector;
  commandEffector: DiscordCommandEffector;
  updateConfig: (updates: Partial<RuntimeConfig>) => void;
}

/**
 * DiscordMessageReceptor - Processes Discord messages into Connectome facets
 *
 * Constraint equivalent: RECEPTOR priority (runs early to transform events to facets)
 */
export class DiscordMessageReceptor {
  private bot: BotInstance;
  private state: SharedState;
  private agentEffector: DiscordAgentEffector;
  private commandEffector: DiscordCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;
  private userNameCache: Map<string, string>;

  constructor(config: DiscordMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.agentEffector = config.agentEffector;
    this.commandEffector = config.commandEffector;
    this.updateConfig = config.updateConfig;
    this.userNameCache = getUserNameCache();
  }

  /**
   * Set up the Discord message event listener
   */
  setup(): void {
    const botName = this.bot.config.name;

    this.bot.discord.on('messageCreate', async (message: Message) => {
      await this.handleMessage(message);
    });

    console.log(`[DiscordMessageReceptor:${botName}] Message handler registered`);
  }

  /**
   * Handle incoming Discord message
   */
  private async handleMessage(message: Message): Promise<void> {
    const botName = this.bot.config.name;

    // Skip messages from THIS bot only
    if (message.author.id === this.bot.userId) return;

    // Build stream ID for tracking
    const streamId = message.guild?.id
      ? `discord:${message.guild.id}:${message.channel.id}`
      : `discord:dm:${message.channel.id}`;

    // Check if message is from any bot (for bot-to-bot limiting)
    const isFromBot = message.author.bot === true;

    // Human message - reset the bot-to-bot counter
    if (!isFromBot && this.state.botInteractionCounts.has(streamId)) {
      console.log(`[DiscordMessageReceptor:${botName}] Human message - resetting bot-to-bot counter for stream ${streamId}`);
      this.state.botInteractionCounts.set(streamId, 0);
    }

    // Check if a specific bot was mentioned in this message
    const mentionedBotName = message.mentions.users
      .map(u => this.state.botUserIdToName.get(u.id))
      .find(name => name !== undefined);

    // Handle ! commands
    const contentWithoutMentions = message.content.trim().replace(/^(<@[!&]?\d+>\s*)+/g, '').trim();
    if (contentWithoutMentions.startsWith('!')) {
      // If a bot was mentioned, only that bot handles the command
      if (mentionedBotName) {
        if (mentionedBotName !== botName) {
          return; // Not the mentioned bot, skip
        }
      } else {
        // No bot mentioned - use deduplication for commands
        if (!messageDeduplicator.shouldEmit(message.id, botName)) {
          return;
        }
      }

      const response = this.commandEffector.handleCommand(
        message.content,
        this.state.runtimeConfig,
        this.updateConfig
      );
      if (response) {
        try {
          if ('send' in message.channel && typeof message.channel.send === 'function') {
            await message.channel.send(response);
            console.log(`[DiscordMessageReceptor:${botName}] Handled command: ${message.content.substring(0, 30)}...`);
          }
        } catch (error: any) {
          console.error(`[DiscordMessageReceptor:${botName}] Error sending command response:`, error.message);
        }
        return; // Command handled, don't forward to Connectome
      }
    }

    // Check if this is a reply to one of our bots
    let replyToBotName: string | undefined;
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        replyToBotName = this.state.botUserIdToName.get(refMsg.author.id);
      } catch {
        // Couldn't fetch referenced message
      }
    }

    // Routing logic: determine if this bot should handle the message
    if (mentionedBotName) {
      if (mentionedBotName !== botName) {
        return; // Not the mentioned bot, skip
      }
      console.log(`[DiscordMessageReceptor:${botName}] Message ${message.id.substring(0, 8)}... mentions me, processing`);
    } else if (replyToBotName) {
      if (replyToBotName !== botName) {
        return; // Not the replied-to bot, skip
      }
      console.log(`[DiscordMessageReceptor:${botName}] Message ${message.id.substring(0, 8)}... is reply to me, processing`);
    } else {
      // No bot mentioned or replied to - check for random reply
      const randomChance = this.state.runtimeConfig.randomReplyChance;

      if (randomChance > 0) {
        const shouldRandomReply = Math.floor(Math.random() * randomChance) === 0;

        if (shouldRandomReply) {
          if (!messageDeduplicator.shouldEmit(message.id, botName)) {
            return;
          }
          console.log(`[DiscordMessageReceptor:${botName}] Random reply triggered (1/${randomChance}) for message ${message.id.substring(0, 8)}...`);
          replyToBotName = botName;
        } else {
          return; // Random chance didn't trigger, skip
        }
      } else {
        return; // Random reply disabled and no mention - skip
      }
    }

    // Bot-to-bot limiting
    if (isFromBot) {
      const currentCount = this.state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = this.state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[DiscordMessageReceptor:${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}) for stream ${streamId}, skipping activation`);
        return;
      }

      this.state.botInteractionCounts.set(streamId, currentCount + 1);
      console.log(`[DiscordMessageReceptor:${botName}] Bot-to-bot interaction ${currentCount + 1}/${maxBotMentions} for stream ${streamId}`);
    }

    try {
      const channelName = 'name' in message.channel ? (message.channel.name ?? 'DM') : 'DM';

      // Ensure stream exists on server
      await this.bot.streamManager.getOrCreateStream(
        message.channel.id,
        {
          channelName,
          channelType: message.channel.isDMBased() ? 'dm' : 'text',
          guildId: message.guild?.id ?? undefined,
          guildName: message.guild?.name ?? undefined
        }
      );

      // Fetch reply info if this is a reply
      let replyTo: { messageId?: string; channelId?: string; authorId?: string; author?: string } | undefined;
      if (message.reference?.messageId) {
        try {
          const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
          replyTo = {
            messageId: message.reference.messageId,
            channelId: message.reference.channelId ?? undefined,
            authorId: referencedMsg?.author?.id,
            author: referencedMsg?.author?.username || referencedMsg?.author?.displayName
          };
        } catch {
          replyTo = {
            messageId: message.reference.messageId,
            channelId: message.reference.channelId ?? undefined
          };
        }
      }

      // Cache user mentions for later resolution
      this.userNameCache.set(message.author.username.toLowerCase(), message.author.id);
      if (message.author.displayName) {
        this.userNameCache.set(message.author.displayName.toLowerCase(), message.author.id);
      }
      for (const [, user] of message.mentions.users) {
        this.userNameCache.set(user.username.toLowerCase(), user.id);
        if (user.displayName) {
          this.userNameCache.set(user.displayName.toLowerCase(), user.id);
        }
      }

      // Emit message to Connectome (for state tracking)
      // Skip emitting for known bots - they record their own speech via agent:speech
      const isFromKnownBot = this.state.botUserIdToName.has(message.author.id);
      if (!isFromKnownBot) {
        await this.bot.grpcClient.emitDiscordMessage({
          content: message.content,
          authorId: message.author.id,
          authorName: message.author.displayName || message.author.username,
          authorTag: message.author.tag,
          channelId: message.channel.id,
          channelName: 'name' in message.channel ? (message.channel.name ?? undefined) : undefined,
          guildId: message.guild?.id ?? undefined,
          guildName: message.guild?.name ?? undefined,
          messageId: message.id,
          timestamp: message.createdTimestamp,
          attachments: message.attachments.map(a => ({
            id: a.id,
            url: a.url,
            name: a.name ?? undefined,
            contentType: a.contentType ?? undefined,
            size: a.size
          })),
          mentions: message.mentions.users.map(u => ({
            id: u.id,
            username: u.username
          })),
          replyTo,
          targetBotName: mentionedBotName || replyToBotName
        });
      }

      console.log(`[DiscordMessageReceptor:${botName}] Message from ${message.author.username}: ${message.content.substring(0, 50)}...`);

      // Trigger agent activation via DiscordAgentEffector
      if (this.bot.agent) {
        await this.agentEffector.runAgentCycle({
          streamId,
          channelId: message.channel.id,
          messageContent: message.content,
          authorName: message.author.displayName || message.author.username
        });
      } else {
        console.log(`[DiscordMessageReceptor:${botName}] No agent configured, skipping response`);
      }
    } catch (error: any) {
      console.error(`[DiscordMessageReceptor:${botName}] Error handling message:`, error.message);
    }
  }
}
