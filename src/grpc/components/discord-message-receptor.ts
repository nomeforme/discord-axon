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

import type { Message, Attachment, PartialMessage } from 'discord.js';
import sharp from 'sharp';

// Image compression settings (match signal-axon)
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_JPEG_QUALITY = 80;
const IMAGE_MAX_BYTES = 3_500_000; // Max compressed size before base64 (~4.7MB base64, under 5MB API limit)
const FILE_MAX_BYTES = parseInt(process.env.FILE_MAX_BYTES || '10000000', 10); // Max non-image file size to download (default 10MB)
import { messageDeduplicator } from '../../message-deduplicator.js';
import { getUserNameCache, getUserIdToNameCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig } from '../types.js';
import type { DiscordCommandEffector } from './discord-command-effector.js';

export interface DiscordMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
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
  private commandEffector: DiscordCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;
  private userNameCache: Map<string, string>;
  private userIdToNameCache: Map<string, string>;

  constructor(config: DiscordMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
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

    this.bot.discord.on('messageUpdate', async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
      await this.handleMessageUpdate(oldMessage, newMessage);
    });

    this.bot.discord.on('messageDelete', async (message: Message | PartialMessage) => {
      await this.handleMessageDelete(message);
    });

    console.log(`[DiscordMessageReceptor:${botName}] Message/update/delete handlers registered`);
  }

  /**
   * Handle incoming Discord message
   */
  private async handleMessage(message: Message): Promise<void> {
    const botName = this.bot.config.name;

    // Skip messages from THIS bot only
    if (message.author.id === this.bot.userId) return;

    // Detect DM vs guild message vs thread
    const isDM = message.channel.isDMBased();
    const isThread = 'isThread' in message.channel && typeof message.channel.isThread === 'function' && message.channel.isThread();
    if (isThread) {
      const parentChannelId = 'parentId' in message.channel ? message.channel.parentId : null;
      console.log(`[DiscordMessageReceptor:${botName}] Thread detected: channel=${message.channel.id} parentChannel=${parentChannelId} guild=${message.guild?.id}`);
    }

    // Skip messages that start with '.' prefix (user opted out of storage/response)
    // DMs skip this check — every message is processed (matches signal-axon behavior)
    const contentWithoutMentions = message.content.trim().replace(/^(<@[!&]?\d+>\s*)+/g, '').trim();
    if (!isDM && contentWithoutMentions.startsWith('.')) {
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

    // Handle !continue / m continue — continuation command (resume truncated bot output)
    // Uses ! command path so it never reaches VEIL on any platform
    if (/^[!]continue\b/i.test(contentWithoutMentions) || /^m\s+(continue|go|more)\b/i.test(contentWithoutMentions)) {
      if (anyBotMentioned && !thisBotMentioned) return;
      if (!anyBotMentioned && !messageDeduplicator.shouldEmit(`continue-${message.id}`, botName)) return;

      console.log(`[DiscordMessageReceptor:${botName}] Continuation command detected`);
      try { await message.delete(); } catch (err: any) {
        console.warn(`[DiscordMessageReceptor:${botName}] Could not delete continuation message: ${err.message}`);
      }
      try {
        await this.bot.grpcClient.activateAgent(streamId, 'continuation', {
          channelId: message.channel.id,
          messageContent: '',
          authorName: message.author.displayName || message.author.username,
          streamType: 'discord',
          targetBot: this.bot.config.agentName || botName,
          continuation: 'true',
        });
        console.log(`[DiscordMessageReceptor:${botName}] Continuation activation sent for stream ${streamId}`);
      } catch (error: any) {
        console.error(`[DiscordMessageReceptor:${botName}] Error sending continuation activation:`, error.message);
      }
      return;
    }

    // Handle ! commands (commands bypass normal message flow — never stored in VEIL)
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

      // Process attachments for !steer commands so files reach the substream
      let commandAttachments: any[] | undefined;
      if (contentWithoutMentions.startsWith('!steer') && message.attachments.size > 0) {
        commandAttachments = await this.processAttachments(message.attachments);
      }

      // For !sysprompt, resolve the first text/* attachment to a UTF-8 string
      // so the effector can install it as the new prompt without needing a
      // gRPC client. Pre-resolves both inline data and blob-store refs.
      let sysPromptFileText: string | undefined;
      if (contentWithoutMentions.toLowerCase().startsWith('!sysprompt') && message.attachments.size > 0) {
        sysPromptFileText = await this.resolveSysPromptAttachment(message.attachments);
      }

      const response = this.commandEffector.handleCommand(
        message.content,
        this.state.runtimeConfig,
        this.updateConfig,
        (topic, payload) => this.bot.grpcClient.emitEvent(topic, { ...payload, streamId }),
        commandAttachments,
        sysPromptFileText,
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

    // Check if message has any attachments (images, files, etc.)
    const hasAttachments = message.attachments.size > 0;

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
    // When a message has attachments and targets specific bots, the first
    // targeted bot (alphabetically) gets emission priority so it also
    // processes attachments for its activation metadata (substream relay).
    let priorityEmitter: string | null = null;
    if (hasAttachments && targetedBotNames.length > 0) {
      // Sort alphabetically and pick first
      targetedBotNames.sort();
      priorityEmitter = targetedBotNames[0];
      console.log(`[DiscordMessageReceptor:${botName}] Message has attachments + targets: [${targetedBotNames.join(', ')}], priority emitter: ${priorityEmitter}`);
    }

    // Track if this bot should skip activation due to not being priority emitter
    let skipActivationForPriority = false;

    // Determine if this bot should emit
    let shouldEmit = false;
    if (isFromKnownBot) {
      // Never emit messages from known bots
      shouldEmit = false;
    } else if (priorityEmitter) {
      // Attachment + targeted case: only priority emitter emits (attachment
      // processing is expensive, and every targeted bot activating with the
      // attachment would compress/upload it N times).
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
    } else if (targetedBotNames.length > 0) {
      // Targeted (non-attachment) case: every targeted bot emits its own copy
      // of the message. The server dedupes on the facet ID (`msg-discord-<id>`)
      // so only the first emit creates a frame — subsequent emits no-op
      // server-side but still receive `waitForFrame` acknowledgment.
      //
      // Why: previously non-emit-winning targeted bots called `activateAgent`
      // immediately, which raced the winner's `emitDiscordMessage`. If the
      // activation reached the server before the message facet landed, the
      // rendered context omitted the trigger — the bot then saw "quiet
      // activation" (its own last reply as the newest visible message).
      // Every targeted bot doing its own emit turns the race into a
      // per-bot sequential barrier: emit awaits frame, then activate.
      shouldEmit = targetedBotNames.includes(botName);
    } else {
      // Untargeted (random-reply / passive) case: fall back to lottery. Only
      // one bot needs to emit since no bot is guaranteed to activate.
      shouldEmit = messageDeduplicator.shouldEmit(message.id, botName);
    }

    // Process attachments once — used for both emit and activation metadata
    let processedAttachments: Awaited<ReturnType<typeof this.processAttachments>> = [];
    if (shouldEmit && message.attachments.size > 0) {
      processedAttachments = await this.processAttachments(message.attachments);
      if (processedAttachments.length > 0) {
        const imageCount = processedAttachments.filter(a => a.data).length;
        console.log(`[DiscordMessageReceptor:${botName}] Processed ${processedAttachments.length} attachment(s), ${imageCount} with image data`);
      }
    }

    if (shouldEmit) {
      try {
        const channelName = 'name' in message.channel ? (message.channel.name ?? 'DM') : 'DM';

        // Determine channel type and parent stream for threads
        const channelType = isDM ? 'dm' : isThread ? 'thread' : 'text';
        let parentStreamId: string | undefined;
        if (isThread && message.guild?.id && 'parentId' in message.channel && message.channel.parentId) {
          parentStreamId = `discord:${message.guild.id}:${message.channel.parentId}`;
        }

        // Ensure stream exists on server
        await this.bot.streamManager.getOrCreateStream(
          message.channel.id,
          {
            channelName,
            channelType: channelType as 'text' | 'voice' | 'dm' | 'thread',
            guildId: message.guild?.id ?? undefined,
            guildName: message.guild?.name ?? undefined,
            parentStreamId,
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

        // Resolve Discord mention IDs to display names (including exogenous bots/users)
        let resolvedContent = message.content.replace(/<@!?(\d+)>/g, (match, id) => {
          const cached = this.userIdToNameCache.get(id);
          if (cached) return `@${cached}`;
          const mentioned = message.mentions.users.get(id);
          if (mentioned) return `@${mentioned.displayName || mentioned.username}`;
          const member = message.guild?.members.cache.get(id);
          if (member) return `@${member.displayName || member.user.username}`;
          return match;
        });

        // Emit message to Connectome
        await this.bot.grpcClient.emitDiscordMessage({
          content: resolvedContent,
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
    } else if (isDM) {
      // DMs always activate — no mention required (matches signal-axon behavior)
      shouldActivate = true;
      activationReason = 'dm';
      console.log(`[DiscordMessageReceptor:${botName}] DM from ${message.author.username}, will activate`);
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
      // Ensure this bot's stream manager is subscribed so its
      // speech effector receives the reply (the emit lottery winner may be a different bot).
      // Re-uses the same channelName/channelType/parentStreamId from the emit block above;
      // getOrCreateStream is idempotent and returns cached info if already created.
      const channelName2 = 'name' in message.channel ? (message.channel.name ?? 'DM') : 'DM';
      const channelType2 = isDM ? 'dm' : isThread ? 'thread' : 'text';
      let parentStreamId2: string | undefined;
      if (isThread && message.guild?.id && 'parentId' in message.channel && message.channel.parentId) {
        parentStreamId2 = `discord:${message.guild.id}:${message.channel.parentId}`;
      }
      // Note: This is NOT a duplicate call — the emit block above only runs for the dedup winner.
      // Non-winning bots that still need to activate must ensure their stream manager is subscribed.
      await this.bot.streamManager.getOrCreateStream(
        message.channel.id,
        {
          channelName: channelName2,
          channelType: channelType2 as 'text' | 'voice' | 'dm' | 'thread',
          guildId: message.guild?.id ?? undefined,
          guildName: message.guild?.name ?? undefined,
          parentStreamId: parentStreamId2,
        }
      );

      // Send typing indicator, refresh every 8s (Discord typing expires after 10s).
      // Kept alive through per-turn speech deliveries. Safety timeout at 10min for
      // long-running workflows (SSH, installs, RLM sub-agents). Cleared on cycle end
      // via agent:typing-stop event, or when the safety timeout fires.
      if ('sendTyping' in message.channel) {
        const ch = message.channel;
        ch.sendTyping().catch(() => {});
        // Clear any existing interval for this stream first
        const existing = this.bot.activeTypingIntervals?.get(streamId);
        if (existing) clearInterval(existing);
        const typingInterval = setInterval(() => {
          ch.sendTyping().catch(() => {
            clearInterval(typingInterval);
            this.bot.activeTypingIntervals?.delete(streamId);
          });
        }, 8000);
        setTimeout(() => { clearInterval(typingInterval); this.bot.activeTypingIntervals?.delete(streamId); }, 600000);
        this.bot.activeTypingIntervals?.set(streamId, typingInterval);
      }

      await this.bot.grpcClient.activateAgent(streamId, activationReason, {
        channelId: message.channel.id,
        messageContent: message.content,
        authorName: message.author.displayName || message.author.username,
        authorId: message.author.id,
        messageId: message.id,
        timestamp: String(message.createdTimestamp),
        streamType: 'discord',
        targetBot: this.bot.config.agentName || botName,
        ...(processedAttachments?.length ? { attachmentsJson: JSON.stringify(processedAttachments) } : {}),
      });
      console.log(`[DiscordMessageReceptor:${botName}] Remote activation sent for stream ${streamId}`);
    } catch (error: any) {
      console.error(`[DiscordMessageReceptor:${botName}] Error triggering agent:`, error.message);
    }
  }

  /**
   * Handle a Discord message edit — update the VEIL facet
   */
  private async handleMessageUpdate(
    oldMessage: Message | PartialMessage,
    newMessage: Message | PartialMessage
  ): Promise<void> {
    const botName = this.bot.config.name;

    // Skip edits from THIS bot
    if (newMessage.author?.id === this.bot.userId) return;

    // Skip if content didn't change (e.g. embed-only updates)
    if (oldMessage.content === newMessage.content) return;

    // Only one bot should emit the update (dedup)
    if (!messageDeduplicator.shouldEmit(`edit-${newMessage.id}`, botName)) return;

    // Fetch full message if partial
    let message = newMessage;
    if (newMessage.partial) {
      try {
        message = await newMessage.fetch();
      } catch {
        console.log(`[DiscordMessageReceptor:${botName}] Could not fetch partial updated message ${newMessage.id}`);
        return;
      }
    }

    try {
      await this.bot.grpcClient.emitDiscordMessageUpdate({
        messageId: message.id,
        content: message.content || '',
        authorId: message.author?.id || '',
        authorName: message.author?.displayName || message.author?.username || 'unknown',
        channelId: message.channelId,
        guildId: message.guildId ?? undefined,
        editedTimestamp: message.editedTimestamp || Date.now(),
      });
      console.log(`[DiscordMessageReceptor:${botName}] Emitted messageUpdate for ${message.id}: ${(message.content || '').substring(0, 50)}...`);
    } catch (error: any) {
      console.error(`[DiscordMessageReceptor:${botName}] Error emitting messageUpdate:`, error.message);
    }
  }

  /**
   * Handle a Discord message deletion — remove the VEIL facet
   */
  private async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    const botName = this.bot.config.name;

    // Skip deletions from THIS bot
    if (message.author?.id === this.bot.userId) return;

    // Only one bot should emit the delete (dedup)
    if (!messageDeduplicator.shouldEmit(`delete-${message.id}`, botName)) return;

    try {
      await this.bot.grpcClient.emitDiscordMessageDelete({
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId ?? undefined,
      });
      console.log(`[DiscordMessageReceptor:${botName}] Emitted messageDelete for ${message.id}`);
    } catch (error: any) {
      console.error(`[DiscordMessageReceptor:${botName}] Error emitting messageDelete:`, error.message);
    }
  }

  /**
   * Process attachments: download from Discord CDN, upload bytes to the
   * Connectome content-addressed blob store, return refs (no inline bytes).
   *
   * This is the inbound path of the blob-store architecture: every byte
   * travels exactly twice on the wire — from Discord CDN to this receptor,
   * and from this receptor into the blob store. The signal:message event
   * emitted afterwards carries only sha256 refs, so the pub/sub broadcast
   * across all bot subscribers stays kilobyte-sized regardless of file size.
   */
  /**
   * Resolve the first text/* attachment in the message to a UTF-8 string.
   *
   * Used by `!sysprompt <mode> file` to load a system prompt from an attached
   * file. Downloads bytes directly from the Discord CDN URL — bypasses the
   * usual blob-store upload since the effector doesn't have a gRPC client
   * and the bytes only live in axon memory for the duration of this call.
   *
   * Silently skips images / binaries / oversized files. Returns undefined if
   * no suitable attachment is found or the download fails.
   */
  private async resolveSysPromptAttachment(
    attachments: Map<string, Attachment>,
  ): Promise<string | undefined> {
    const MAX_TEXT_BYTES = 64 * 1024; // 64 KB — plenty for a system prompt
    const botName = this.bot.config.name;

    for (const [, att] of attachments) {
      const ct = (att.contentType || '').toLowerCase();
      const nameLower = (att.name || '').toLowerCase();
      const isText =
        ct.startsWith('text/') ||
        /\.(txt|md|markdown|prompt)$/i.test(nameLower);
      if (!isText) continue;
      if (att.size > MAX_TEXT_BYTES) {
        console.warn(
          `[DiscordMessageReceptor:${botName}] Skipping sysprompt attachment ${att.name}: ${att.size} bytes > ${MAX_TEXT_BYTES} limit`,
        );
        continue;
      }
      if (!att.url) continue;
      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          console.warn(
            `[DiscordMessageReceptor:${botName}] Sysprompt attachment fetch failed: ${res.status} ${res.statusText}`,
          );
          continue;
        }
        const text = await res.text();
        console.log(
          `[DiscordMessageReceptor:${botName}] Resolved sysprompt attachment ${att.name} (${text.length} chars)`,
        );
        return text;
      } catch (err: any) {
        console.warn(
          `[DiscordMessageReceptor:${botName}] Sysprompt attachment download error: ${err.message}`,
        );
      }
    }
    return undefined;
  }

  private async processAttachments(attachments: Map<string, Attachment>): Promise<Array<{
    id: string;
    url: string;
    name?: string;
    contentType?: string;
    size: number;
    blobId?: string;
    data?: string;
  }>> {
    const botName = this.bot.config.name;
    const processed: Array<{
      id: string;
      url: string;
      name?: string;
      contentType?: string;
      size: number;
      blobId?: string;
      data?: string;
    }> = [];

    for (const [, att] of attachments) {
      const contentType = att.contentType || '';
      const isImage = contentType.startsWith('image/');

      if (isImage && att.url) {
        // Download image, compress, and convert to base64
        const base64Data = await this.downloadAttachment(att.url, botName);
        const finalContentType = base64Data ? 'image/jpeg' : contentType;
        const blobId = await this.uploadBase64ToBlobStore(base64Data, finalContentType, att.name ?? undefined, botName);
        processed.push({
          id: att.id,
          url: att.url,
          name: att.name ?? undefined,
          contentType: finalContentType,
          size: att.size,
          ...(blobId ? { blobId } : (base64Data ? { data: base64Data } : {})),
        });
      } else if (att.url && att.size <= FILE_MAX_BYTES) {
        // Non-image attachment: download and include as base64
        const base64Data = await this.downloadFileAttachment(att.url, botName);
        const blobId = await this.uploadBase64ToBlobStore(base64Data, contentType || 'application/octet-stream', att.name ?? undefined, botName);
        processed.push({
          id: att.id,
          url: att.url,
          name: att.name ?? undefined,
          contentType: contentType || undefined,
          size: att.size,
          ...(blobId ? { blobId } : (base64Data ? { data: base64Data } : {})),
        });
      } else {
        // Too large or no URL — metadata only (no bytes to upload)
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
   * Upload base64-encoded bytes to the Connectome blob store. Returns the
   * sha256 blob_id on success, null on failure (caller falls back to inline).
   */
  private async uploadBase64ToBlobStore(
    base64Data: string | null,
    contentType: string,
    filename: string | undefined,
    botName: string
  ): Promise<string | null> {
    if (!base64Data) return null;
    try {
      const bytes = Buffer.from(base64Data, 'base64');
      const result = await this.bot.grpcClient.putBlob(new Uint8Array(bytes), {
        contentType,
        filename,
      });
      if (result.alreadyExisted) {
        console.log(`[DiscordMessageReceptor:${botName}] Blob ${result.blobId.substring(0, 12)}... already in store (dedup hit, ${bytes.length} bytes)`);
      } else {
        console.log(`[DiscordMessageReceptor:${botName}] Uploaded blob ${result.blobId.substring(0, 12)}... (${bytes.length} bytes, ${contentType})`);
      }
      return result.blobId;
    } catch (err: any) {
      console.warn(`[DiscordMessageReceptor:${botName}] Blob upload failed for ${filename || '?'}: ${err.message} — will fall back to inline bytes`);
      return null;
    }
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
   * Download a non-image file attachment from Discord CDN and return as raw base64
   */
  private async downloadFileAttachment(url: string, botName: string): Promise<string | null> {
    try {
      console.log(`[DiscordMessageReceptor:${botName}] Downloading file attachment from ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[DiscordMessageReceptor:${botName}] Failed to download file: ${response.status}`);
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > FILE_MAX_BYTES) {
        console.warn(`[DiscordMessageReceptor:${botName}] File too large (${buffer.length} bytes), skipping`);
        return null;
      }
      console.log(`[DiscordMessageReceptor:${botName}] Downloaded file attachment: ${buffer.length} bytes`);
      return buffer.toString('base64');
    } catch (error) {
      console.error(`[DiscordMessageReceptor:${botName}] Error downloading file attachment:`, error);
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
