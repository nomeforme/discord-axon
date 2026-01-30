/**
 * Discord message event handlers for gRPC mode
 */

import type { Message, Interaction } from 'discord.js';
import { messageDeduplicator } from '../message-deduplicator.js';
import { handleCommand } from './commands.js';
import { getUserNameCache } from './utils/mention-resolver.js';
import { runAgentForMessage } from './agent-runner.js';
import type { BotInstance, SharedState, RuntimeConfig } from './types.js';

/**
 * Set up Discord ready event handler
 */
export function setupReadyHandler(
  bot: BotInstance,
  state: SharedState
): void {
  const botName = bot.config.name;
  const userNameCache = getUserNameCache();

  bot.discord.on('ready', async () => {
    console.log(`[${botName}] Logged in as ${bot.discord.user?.tag}`);
    bot.userId = bot.discord.user?.id;

    if (bot.userId) {
      state.botUserIdToName.set(bot.userId, botName);

      // Cache bot's Discord names for mention resolution
      const userId = bot.userId;
      if (bot.discord.user?.username) {
        userNameCache.set(bot.discord.user.username.toLowerCase(), userId);
        console.log(`[${botName}] Cached username: ${bot.discord.user.username} -> ${userId}`);
      }
      if (bot.discord.user?.displayName) {
        userNameCache.set(bot.discord.user.displayName.toLowerCase(), userId);
        console.log(`[${botName}] Cached displayName: ${bot.discord.user.displayName} -> ${userId}`);
      }
      // Also cache config name variations
      userNameCache.set(botName.toLowerCase(), userId);
      userNameCache.set(botName.toLowerCase().replace(/-/g, ' '), userId);

      // Emit discord:connected to register bot mapping on server
      try {
        await bot.grpcClient.emitDiscordConnected({
          botUserId: bot.userId,
          botId: botName,
          botUsername: bot.discord.user?.username || botName,
          botDisplayName: bot.discord.user?.displayName || botName
        });
        console.log(`[${botName}] Registered bot mapping on server`);
      } catch (error: any) {
        console.error(`[${botName}] Failed to register bot mapping:`, error.message);
      }
    }
  });
}

/**
 * Set up Discord message event handler
 */
export function setupMessageHandler(
  bot: BotInstance,
  state: SharedState,
  updateConfig: (updates: Partial<RuntimeConfig>) => void
): void {
  const botName = bot.config.name;
  const userNameCache = getUserNameCache();

  bot.discord.on('messageCreate', async (message: Message) => {
    // Skip messages from THIS bot only
    if (message.author.id === bot.userId) return;

    // Build stream ID for tracking
    const streamId = message.guild?.id
      ? `discord:${message.guild.id}:${message.channel.id}`
      : `discord:dm:${message.channel.id}`;

    // Check if message is from any bot (for bot-to-bot limiting)
    const isFromBot = message.author.bot === true;

    // Human message - reset the bot-to-bot counter
    if (!isFromBot && state.botInteractionCounts.has(streamId)) {
      console.log(`[${botName}] Human message - resetting bot-to-bot counter for stream ${streamId}`);
      state.botInteractionCounts.set(streamId, 0);
    }

    // Check if a specific bot was mentioned in this message
    const mentionedBotName = message.mentions.users
      .map(u => state.botUserIdToName.get(u.id))
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

      const response = handleCommand(message.content, state.runtimeConfig, updateConfig);
      if (response) {
        try {
          if ('send' in message.channel && typeof message.channel.send === 'function') {
            await message.channel.send(response);
            console.log(`[${botName}] Handled command: ${message.content.substring(0, 30)}...`);
          }
        } catch (error: any) {
          console.error(`[${botName}] Error sending command response:`, error.message);
        }
        return; // Command handled, don't forward to Connectome
      }
    }

    // Check if this is a reply to one of our bots
    let replyToBotName: string | undefined;
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        replyToBotName = state.botUserIdToName.get(refMsg.author.id);
      } catch {
        // Couldn't fetch referenced message
      }
    }

    // Routing logic: determine if this bot should handle the message
    if (mentionedBotName) {
      if (mentionedBotName !== botName) {
        return; // Not the mentioned bot, skip
      }
      console.log(`[${botName}] Message ${message.id.substring(0, 8)}... mentions me, processing`);
    } else if (replyToBotName) {
      if (replyToBotName !== botName) {
        return; // Not the replied-to bot, skip
      }
      console.log(`[${botName}] Message ${message.id.substring(0, 8)}... is reply to me, processing`);
    } else {
      // No bot mentioned or replied to - check for random reply
      const randomChance = state.runtimeConfig.randomReplyChance;

      if (randomChance > 0) {
        const shouldRandomReply = Math.floor(Math.random() * randomChance) === 0;

        if (shouldRandomReply) {
          if (!messageDeduplicator.shouldEmit(message.id, botName)) {
            return;
          }
          console.log(`[${botName}] Random reply triggered (1/${randomChance}) for message ${message.id.substring(0, 8)}...`);
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
      const currentCount = state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}) for stream ${streamId}, skipping activation`);
        return;
      }

      state.botInteractionCounts.set(streamId, currentCount + 1);
      console.log(`[${botName}] Bot-to-bot interaction ${currentCount + 1}/${maxBotMentions} for stream ${streamId}`);
    }

    try {
      const channelName = 'name' in message.channel ? (message.channel.name ?? 'DM') : 'DM';

      // Ensure stream exists
      await bot.streamManager.getOrCreateStream(
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
      userNameCache.set(message.author.username.toLowerCase(), message.author.id);
      if (message.author.displayName) {
        userNameCache.set(message.author.displayName.toLowerCase(), message.author.id);
      }
      for (const [, user] of message.mentions.users) {
        userNameCache.set(user.username.toLowerCase(), user.id);
        if (user.displayName) {
          userNameCache.set(user.displayName.toLowerCase(), user.id);
        }
      }

      // Emit message to Connectome (for state tracking)
      // Skip emitting for known bots - they record their own speech via agent:speech
      const isFromKnownBot = state.botUserIdToName.has(message.author.id);
      if (!isFromKnownBot) {
        await bot.grpcClient.emitDiscordMessage({
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

      console.log(`[${botName}] Message from ${message.author.username}: ${message.content.substring(0, 50)}...`);

      // Run agent directly (client-side execution)
      if (bot.agent) {
        await runAgentForMessage({
          agent: bot.agent,
          botConfig: bot.config,
          grpcClient: bot.grpcClient,
          discordClient: bot.discord,
          streamId,
          channelId: message.channel.id,
          botUserIdToName: state.botUserIdToName,
          messageContent: message.content,
          authorName: message.author.displayName || message.author.username,
          config: {
            maxFrames: state.runtimeConfig.maxConversationFrames
          }
        });
      } else {
        console.log(`[${botName}] No agent configured, skipping response`);
      }
    } catch (error: any) {
      console.error(`[${botName}] Error handling message:`, error.message);
    }
  });
}

/**
 * Set up Discord interaction event handler
 */
export function setupInteractionHandler(bot: BotInstance): void {
  const botName = bot.config.name;

  bot.discord.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        // Ensure stream exists
        await bot.streamManager.getOrCreateStream(
          interaction.channelId,
          {
            guildId: interaction.guildId ?? undefined,
            guildName: interaction.guild?.name ?? undefined
          }
        );

        // Emit slash command interaction
        await bot.grpcClient.emitDiscordInteraction({
          type: 'slash-command',
          commandName: interaction.commandName,
          options: [...interaction.options.data],
          userId: interaction.user.id,
          userName: interaction.user.username,
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          interactionId: interaction.id,
          timestamp: interaction.createdTimestamp
        });

        // Defer reply
        await interaction.deferReply();
      } else if (interaction.isButton()) {
        await bot.grpcClient.emitDiscordInteraction({
          type: 'button',
          customId: interaction.customId,
          userId: interaction.user.id,
          userName: interaction.user.username,
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          interactionId: interaction.id,
          timestamp: interaction.createdTimestamp
        });
      }
    } catch (error: any) {
      console.error(`[${botName}] Error handling interaction:`, error.message);
    }
  });
}

/**
 * Set up Discord reaction event handler
 */
export function setupReactionHandler(
  bot: BotInstance,
  state: SharedState
): void {
  const botName = bot.config.name;

  bot.discord.on('messageReactionAdd', async (reaction, user) => {
    if (state.botUserIdToName.has(user.id)) return;

    try {
      await bot.grpcClient.emitDiscordReaction({
        emoji: reaction.emoji.name ?? reaction.emoji.id ?? '',
        userId: user.id,
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        guildId: reaction.message.guildId ?? undefined,
        added: true,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error(`[${botName}] Error handling reaction:`, error.message);
    }
  });
}
