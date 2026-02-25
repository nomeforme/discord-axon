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

import type { Message, Attachment } from 'discord.js';
import sharp from 'sharp';

// Image compression settings (match signal-axon)
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_JPEG_QUALITY = 80;
const IMAGE_MAX_BYTES = 3_500_000; // Max compressed size before base64 (~4.7MB base64, under 5MB API limit)
import { messageDeduplicator } from '../../message-deduplicator.js';
import { getUserNameCache, getUserIdToNameCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig } from '../types.js';
import type { DiscordAgentEffector } from './discord-agent-effector.js';
import type { DiscordCommandEffector } from './discord-command-effector.js';

export interface DiscordMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
  agentEffector?: DiscordAgentEffector;
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
  private agentEffector?: DiscordAgentEffector;
  private commandEffector: DiscordCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;
  private userNameCache: Map<string, string>;
  private userIdToNameCache: Map<string, string>;

  constructor(config: DiscordMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.agentEffector = config.agentEffector;
    this.commandEffector = config.commandEffector;
    this.updateConfig = config.updateConfig;
    this.userNameCache = getUserNameCache();
    this.userIdToNameCache = getUserIdToNameCache();
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

    // Skip messages that start with '.' prefix (user opted out of storage/response)
    const contentWithoutMentions = message.content.trim().replace(/^(<@[!&]?\d+>\s*)+/g, '').trim();
    if (contentWithoutMentions.startsWith('.')) {
      console.log(`[DiscordMessageReceptor:${botName}] Message starts with '.', skipping storage and response`);
      return;
    }

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

    // Check if THIS bot was mentioned, and if ANY bot was mentioned
    const thisBotMentioned = message.mentions.users.some(
      u => this.state.botUserIdToName.get(u.id) === botName
    );
    const anyBotMentioned = message.mentions.users.some(
      u => this.state.botUserIdToName.has(u.id)
    );

    // Handle ! commands (commands bypass normal message flow)
    if (contentWithoutMentions.startsWith('!')) {
      // If a bot was mentioned, only that bot handles the command
      if (anyBotMentioned) {
        if (!thisBotMentioned) {
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

    // ========================================================================
    // EMIT TO CONNECTOME - Only ONE bot emits each message
    // Check dedup BEFORE processing attachments to avoid 13x download/compress
    //
    // SPECIAL CASE: If message has attachments AND targets specific bot(s) (mention/reply),
    // the first targeted bot (alphabetically) gets emission priority instead of dedup lottery.
    // This ensures the targeted bot has attachments in context when it activates.
    // ========================================================================
    const isFromKnownBot = this.state.botUserIdToName.has(message.author.id);

    // Check if message has image attachments
    const hasImageAttachments = [...message.attachments.values()].some(
      att => att.contentType?.startsWith('image/')
    );

    // Find all targeted bots (mentioned + replied to)
    const targetedBotNames: string[] = [];
    for (const [, user] of message.mentions.users) {
      const name = this.state.botUserIdToName.get(user.id);
      if (name && !targetedBotNames.includes(name)) {
        targetedBotNames.push(name);
      }
    }
    if (replyToBotName && !targetedBotNames.includes(replyToBotName)) {
      targetedBotNames.push(replyToBotName);
    }

    // Determine priority emitter for attachment+targeted case
    let priorityEmitter: string | null = null;
    if (hasImageAttachments && targetedBotNames.length > 0) {
      // Sort alphabetically and pick first
      targetedBotNames.sort();
      priorityEmitter = targetedBotNames[0];
      console.log(`[DiscordMessageReceptor:${botName}] Message has image + targets: [${targetedBotNames.join(', ')}], priority emitter: ${priorityEmitter}`);
    }

    // Track if this bot should skip activation due to not being priority emitter
    let skipActivationForPriority = false;

    // Determine if this bot should emit
    let shouldEmit = false;
    if (isFromKnownBot) {
      // Never emit messages from known bots
      shouldEmit = false;
    } else if (priorityEmitter) {
      // Attachment + targeted case: only priority emitter emits
      if (botName === priorityEmitter) {
        shouldEmit = true;
        console.log(`[DiscordMessageReceptor:${botName}] I am priority emitter for attachment message`);
      } else if (targetedBotNames.includes(botName)) {
        // This bot is targeted but not priority emitter - skip both emit and activation
        skipActivationForPriority = true;
        console.log(`[DiscordMessageReceptor:${botName}] Skipping (targeted but not priority emitter, ${priorityEmitter} will handle)`);
      } else {
        console.log(`[DiscordMessageReceptor:${botName}] Not priority emitter, ${priorityEmitter} will emit`);
      }
    } else {
      // Normal case: use deduplication lottery
      shouldEmit = messageDeduplicator.shouldEmit(message.id, botName);
    }

    if (shouldEmit) {
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

        // Process attachments - only the emitting bot does this
        const processedAttachments = await this.processAttachments(message.attachments);
        if (processedAttachments.length > 0) {
          const imageCount = processedAttachments.filter(a => a.data).length;
          console.log(`[DiscordMessageReceptor:${botName}] Processed ${processedAttachments.length} attachment(s), ${imageCount} with image data`);
        }

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

        // Cache user mentions for later resolution (both directions)
        this.userNameCache.set(message.author.username.toLowerCase(), message.author.id);
        this.userIdToNameCache.set(message.author.id, message.author.displayName || message.author.username);
        if (message.author.displayName) {
          this.userNameCache.set(message.author.displayName.toLowerCase(), message.author.id);
        }
        for (const [, user] of message.mentions.users) {
          this.userNameCache.set(user.username.toLowerCase(), user.id);
          this.userIdToNameCache.set(user.id, user.displayName || user.username);
          if (user.displayName) {
            this.userNameCache.set(user.displayName.toLowerCase(), user.id);
          }
        }

        // Emit message to Connectome
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
          attachments: processedAttachments,
          mentions: message.mentions.users.map(u => ({
            id: u.id,
            username: u.username
          })),
          replyTo,
          targetBotName: targetedBotNames[0] || replyToBotName
        });
        console.log(`[DiscordMessageReceptor:${botName}] Emitted message to Connectome from ${message.author.username}: ${message.content.substring(0, 50)}...`);
      } catch (error: any) {
        console.error(`[DiscordMessageReceptor:${botName}] Error emitting message to Connectome:`, error.message);
      }
    }

    // ========================================================================
    // ACTIVATION CHECK - Determine if this bot should respond
    // This is separate from emission - message is already stored in Connectome
    // ========================================================================
    let shouldActivate = false;
    let activationReason = '';

    if (thisBotMentioned) {
      shouldActivate = true;
      activationReason = 'mentioned';
      console.log(`[DiscordMessageReceptor:${botName}] Message ${message.id.substring(0, 8)}... mentions me, will activate`);
    } else if (replyToBotName === botName) {
      shouldActivate = true;
      activationReason = 'reply';
      console.log(`[DiscordMessageReceptor:${botName}] Message ${message.id.substring(0, 8)}... is reply to me, will activate`);
    } else if (anyBotMentioned || replyToBotName) {
      // Another bot was targeted (mentioned or replied to), don't activate
    } else {
      // No bot mentioned or replied to - check for random reply
      const randomChance = this.state.runtimeConfig.randomReplyChance;

      if (randomChance > 0) {
        const shouldRandomReply = Math.floor(Math.random() * randomChance) === 0;

        if (shouldRandomReply) {
          if (messageDeduplicator.shouldEmit(`random-${message.id}`, botName)) {
            shouldActivate = true;
            activationReason = 'random';
            console.log(`[DiscordMessageReceptor:${botName}] Random reply triggered (1/${randomChance}) for message ${message.id.substring(0, 8)}...`);
          }
        }
      }
      // If random chance didn't trigger, don't activate (but message was still emitted above)
    }

    // If not activating, we're done (message was already emitted to Connectome)
    if (!shouldActivate) {
      return;
    }

    // Skip activation if this bot was targeted but not the priority emitter
    // (The priority emitter will handle both emit and activation)
    if (skipActivationForPriority) {
      return;
    }

    // Bot-to-bot limiting (only applies to activation, not emission)
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

    // ========================================================================
    // TRIGGER AGENT - Only if we passed all activation checks
    // Attachments flow through server context (single source of truth pattern)
    // ========================================================================
    try {
      if (this.agentEffector) {
        // Local bot — run agent in-process
        await this.agentEffector.runAgentCycle({
          streamId,
          channelId: message.channel.id,
          messageContent: message.content,
          authorName: message.author.displayName || message.author.username
        });
      } else {
        // Remote bot — ensure this bot's stream manager is subscribed so its
        // speech effector receives the reply (the emit lottery winner may be a different bot)
        const channelName = 'name' in message.channel ? (message.channel.name ?? 'DM') : 'DM';
        await this.bot.streamManager.getOrCreateStream(
          message.channel.id,
          {
            channelName,
            channelType: message.channel.isDMBased() ? 'dm' : 'text',
            guildId: message.guild?.id ?? undefined,
            guildName: message.guild?.name ?? undefined
          }
        );

        // Send typing indicator, refresh every 8s (Discord typing expires after 10s)
        // Cleared by speech effector on delivery, or auto-clears after 120s as safety net.
        if ('sendTyping' in message.channel) {
          const ch = message.channel;
          ch.sendTyping().catch(() => {});
          const typingInterval = setInterval(() => {
            ch.sendTyping().catch(() => {
              clearInterval(typingInterval);
              this.bot.activeTypingIntervals?.delete(streamId);
            });
          }, 8000);
          setTimeout(() => { clearInterval(typingInterval); this.bot.activeTypingIntervals?.delete(streamId); }, 120000);
          this.bot.activeTypingIntervals?.set(streamId, typingInterval);
        }

        await this.bot.grpcClient.activateAgent(streamId, activationReason, {
          channelId: message.channel.id,
          messageContent: message.content,
          authorName: message.author.displayName || message.author.username,
          streamType: 'discord',
          targetBot: botName
        });
        console.log(`[DiscordMessageReceptor:${botName}] Remote activation sent for stream ${streamId}`);
      }
    } catch (error: any) {
      console.error(`[DiscordMessageReceptor:${botName}] Error triggering agent:`, error.message);
    }
  }

  /**
   * Process attachments: download images and convert to base64
   */
  private async processAttachments(attachments: Map<string, Attachment>): Promise<Array<{
    id: string;
    url: string;
    name?: string;
    contentType?: string;
    size: number;
    data?: string;
  }>> {
    const botName = this.bot.config.name;
    const processed: Array<{
      id: string;
      url: string;
      name?: string;
      contentType?: string;
      size: number;
      data?: string;
    }> = [];

    for (const [, att] of attachments) {
      const contentType = att.contentType || '';
      const isImage = contentType.startsWith('image/');

      if (isImage && att.url) {
        // Download image, compress, and convert to base64
        const base64Data = await this.downloadAttachment(att.url, botName);
        processed.push({
          id: att.id,
          url: att.url,
          name: att.name ?? undefined,
          contentType: base64Data ? 'image/jpeg' : contentType,  // JPEG after compression
          size: att.size,
          data: base64Data ?? undefined
        });
      } else {
        // Non-image attachment, include metadata only
        processed.push({
          id: att.id,
          url: att.url,
          name: att.name ?? undefined,
          contentType: contentType || undefined,
          size: att.size
        });
      }
    }

    return processed;
  }

  /**
   * Download an attachment from Discord CDN and return as compressed base64
   */
  private async downloadAttachment(url: string, botName: string): Promise<string | null> {
    try {
      console.log(`[DiscordMessageReceptor:${botName}] Downloading attachment from ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[DiscordMessageReceptor:${botName}] Failed to download attachment: ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const originalSize = buffer.length;

      // Compress image: resize to max dimension and convert to JPEG
      const compressed = await this.compressImage(buffer, botName);
      if (compressed) {
        const base64 = compressed.toString('base64');
        console.log(`[DiscordMessageReceptor:${botName}] Downloaded and compressed attachment: ${originalSize} -> ${compressed.length} bytes (${Math.round(compressed.length / originalSize * 100)}%)`);
        return base64;
      }

      // Compression failed - skip rather than sending uncompressed (could exceed API limits)
      console.warn(`[DiscordMessageReceptor:${botName}] Compression failed, skipping attachment (${originalSize} bytes)`);
      return null;
    } catch (error) {
      console.error(`[DiscordMessageReceptor:${botName}] Error downloading attachment:`, error);
      return null;
    }
  }

  /**
   * Compress an image: resize to max dimension and convert to JPEG
   */
  private async compressImage(buffer: Buffer, botName: string): Promise<Buffer | null> {
    try {
      // Get image metadata
      const metadata = await sharp(buffer).metadata();
      const { width, height, format } = metadata;

      if (!width || !height) {
        console.log(`[DiscordMessageReceptor:${botName}] Could not get image dimensions, skipping compression`);
        return null;
      }

      // Check if resizing is needed
      const maxDim = Math.max(width, height);
      const needsResize = maxDim > IMAGE_MAX_DIMENSION;

      // Skip compression for small JPEGs that are already under size limit
      if (!needsResize && format === 'jpeg' && buffer.length <= IMAGE_MAX_BYTES) {
        console.log(`[DiscordMessageReceptor:${botName}] Image already optimized (${width}x${height} ${format}, ${buffer.length} bytes)`);
        return buffer;
      }

      // Build sharp pipeline
      let pipeline = sharp(buffer);

      // Resize if needed (maintain aspect ratio)
      if (needsResize) {
        pipeline = pipeline.resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Convert to JPEG
      let compressed = await pipeline
        .jpeg({ quality: IMAGE_JPEG_QUALITY })
        .toBuffer();

      // If still too large, recompress with lower quality and smaller dimensions
      if (compressed.length > IMAGE_MAX_BYTES) {
        console.log(`[DiscordMessageReceptor:${botName}] First pass too large (${compressed.length} bytes), recompressing`);
        compressed = await sharp(compressed)
          .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 50 })
          .toBuffer();
      }
      if (compressed.length > IMAGE_MAX_BYTES) {
        console.log(`[DiscordMessageReceptor:${botName}] Second pass still too large (${compressed.length} bytes), recompressing aggressively`);
        compressed = await sharp(compressed)
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 30 })
          .toBuffer();
      }

      console.log(`[DiscordMessageReceptor:${botName}] Compressed image: ${width}x${height} ${format} -> JPEG ${compressed.length} bytes (${needsResize ? 'resized' : 'same size'})`);
      return compressed;
    } catch (error) {
      console.error(`[DiscordMessageReceptor:${botName}] Image compression failed:`, error);
      return null;
    }
  }
}
