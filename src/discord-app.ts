/**
 * Discord Application for Connectome
 *
 * FLEX Architecture - All components extend Component directly with explicit constraints.
 */

import type { ConnectomeApplication } from 'connectome-ts';
import {
  Space,
  VEILStateManager,
  ComponentRegistry,
  AgentComponent,
  persistable,
  persistent,
  Component,
  ComponentManager,
  AxonLoaderComponent,
  updateStateFacets,
  priorityConstraint,
  ComponentPriority,
  createAgentActivation
} from 'connectome-ts';
import type { SpaceEvent, ExecutionContext, Facet, ReadonlyVEILState } from 'connectome-ts';
import { FocusedContextTransform } from './focused-context-transform.js';

export interface DiscordBotConfig {
  agentName: string;
  botId: string;
  systemPrompt: string;
  token: string;
  guild?: string;
  autoJoinChannels?: string[];
}

export interface DiscordAppConfig {
  agentName: string;
  systemPrompt: string;
  llmProviderId: string;
  botId?: string;        // Which bot to use (for multi-bot support)
  botToken?: string;     // Bot token (backwards compat)
  skipAgentComponent?: boolean;  // Skip creating AgentComponent (use ToolLoopAgent instead)
  // Multi-bot support: array of bot configs
  bots?: DiscordBotConfig[];
  discord: {
    host: string;
    guild: string;
    botId?: string;      // Which bot to use (passed to afferent)
    modulePort?: number;
    autoJoinChannels?: string[];
  };
}

/**
 * FLEX Component: Discord Message Receptor
 *
 * Handles all Discord event-to-facet transformations:
 * - discord:connected → config facets + connection event
 * - discord:message → message facets + agent activations
 * - discord:history-sync → offline edit/delete detection
 * - discord:messageUpdate → message edit handling
 * - discord:messageDelete → message deletion handling
 *
 * Constraint: priority 100 (Standard receptor priority)
 */
class DiscordMessageReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];

  execute(context: ExecutionContext): void {
    const { event, state } = context;

    switch (event.topic) {
      case 'discord:connected':
        this.handleConnected(event, state);
        break;
      case 'discord:message':
        this.handleMessage(event, state);
        break;
      case 'discord:history-sync':
        this.handleHistorySync(event, state);
        break;
      case 'discord:messageUpdate':
        this.handleMessageUpdate(event, state);
        break;
      case 'discord:messageDelete':
        this.handleMessageDelete(event, state);
        break;
    }
  }

  private handleConnected(event: SpaceEvent, state: ReadonlyVEILState): void {
    console.log('[DiscordMessageReceptor] Processing discord:connected event');
    const payload = event.payload as any;

    // Multi-bot support: Store bot user ID -> agent name mapping
    // Each bot connection adds to the map, not replaces
    if (payload.botUserId && payload.botId) {
      const agentName = payload.botId;  // botId is the agent name in our config
      console.log(`[DiscordMessageReceptor] Storing bot mapping: ${payload.botUserId} -> ${agentName}`);

      // Get existing bot map or create new one
      const existingMapFacet = state.facets.get('discord-config-botUserMap');
      const existingMap = existingMapFacet?.state?.value || {};

      // Add this bot to the map
      const updatedMap = {
        ...existingMap,
        [payload.botUserId]: {
          agentName,
          botId: payload.botId,
          username: payload.botUsername,
          displayName: payload.botDisplayName
        }
      };

      for (const delta of updateStateFacets('discord-config', { botUserMap: updatedMap }, state)) {
        this.addOperation(delta);
      }

      // Also keep single botUserId for backwards compat (first bot to connect)
      if (!existingMapFacet) {
        for (const delta of updateStateFacets('discord-config', { botUserId: payload.botUserId }, state)) {
          this.addOperation(delta);
        }
      }
    }

    // NOTE: Identity ambient facets removed - they caused context pollution
    // in multi-bot setups (all bots saw all identities). Identity should be
    // handled via system prompts in the agent config or ContextTransform.

    // Create the connection event facet
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-connected-${payload.botId || 'default'}-${Date.now()}`,
        type: 'event',
        content: `Discord connected (${payload.botId || 'default'})`,
        state: {
          source: 'discord',
          eventType: 'discord-connected'
        },
        attributes: payload as Record<string, any>
      }
    });
  }

  private handleMessage(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { channelId, channelName, author, authorId, content, rawContent, mentions, attachments, reply, messageId, streamId, streamType, isBot } = payload;

    // Check if we've already processed this message (de-dup against VEIL)
    const lastReadFacet = state.facets.get(`discord-lastread-${channelId}`);
    const lastMessageId = lastReadFacet?.state?.value;

    if (lastMessageId && this.isOlderOrEqual(messageId, lastMessageId)) {
      console.log(`[DiscordMessageReceptor] Skipping old/duplicate message ${messageId}`);
      return;
    }

    console.log(`[DiscordMessageReceptor] Processing message from ${author}: "${content}"${reply ? ' (reply)' : ''}`);

    // Retrieve bot user map from VEIL state (multi-bot support)
    const botMapFacet = state.facets.get('discord-config-botUserMap');
    const botUserMap: Record<string, { agentName: string; botId: string; username: string; displayName: string }> = botMapFacet?.state?.value || {};

    // Fallback to single botUserId for backwards compat
    const singleBotFacet = state.facets.get('discord-config-botUserId');
    const singleBotUserId = singleBotFacet?.state?.value;

    if (Object.keys(botUserMap).length === 0 && !singleBotUserId) {
      console.warn('[DiscordMessageReceptor] No bot user IDs found in VEIL state, skipping activation checks');
    }

    // Format content with reply syntax if this is a reply
    let formattedContent = content;
    let replyToUsername = null;

    if (reply) {
      const referencedFacet = state.facets.get(`discord-msg-${reply.messageId}`);
      if (referencedFacet && referencedFacet.state?.metadata?.author) {
        replyToUsername = referencedFacet.state.metadata.author;
      } else if (reply.author) {
        replyToUsername = reply.author;
      }

      if (replyToUsername) {
        formattedContent = `<reply:@${replyToUsername}> ${content}`;
      }
    }

    // Create speech facet as nested child
    const speechFacet: any = {
      id: `speech-${messageId}`,
      type: 'speech',
      content: formattedContent,
      streamId,
      streamType,
      state: {
        speakerId: `discord:${authorId}`,
        speaker: author,
        metadata: { attachments }
      }
    };

    // If this is from any of our bots, mark it as agent-generated
    const botInfo = botUserMap[authorId];
    if (botInfo || authorId === singleBotUserId) {
      speechFacet.agentId = botInfo?.agentName || 'connectome';
      speechFacet.agentName = botInfo?.displayName || botInfo?.username || 'Connectome';
    }

    // Create message facet with speech nested inside
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `discord-msg-${messageId}`,
        type: 'event',
        state: {
          source: 'discord',
          eventType: 'discord-message',
          metadata: { channelName, author, authorId, isBot, rawContent, mentions, attachments, reply }
        },
        streamId,
        streamType,
        attributes: { channelId, messageId, mentions, reply },
        children: [speechFacet]
      }
    });

    // Update lastRead in VEIL
    for (const delta of updateStateFacets('discord-lastread', { [channelId]: messageId }, state)) {
      this.addOperation(delta);
    }

    // Multi-bot activation: Check which bot(s) are mentioned or replied to
    const activatePattern = /<activate\s+([^>]+)>/i;
    const activateMatch = rawContent?.match(activatePattern);
    const fallbackActivate = activateMatch !== null && activateMatch !== undefined;

    // Debug: Log the bot map and mentions
    console.log(`[DiscordMessageReceptor] Bot user map:`, JSON.stringify(botUserMap));
    console.log(`[DiscordMessageReceptor] Mentions:`, JSON.stringify(mentions));

    // Collect all bots that should be activated
    const botsToActivate: Array<{ agentName: string; reason: string }> = [];

    // Check each bot in the map
    for (const [botUserId, botInfo] of Object.entries(botUserMap)) {
      const botMentioned = mentions?.users?.some((u: any) => u.id === botUserId);
      const replyingToBot = reply?.authorId === botUserId;
      console.log(`[DiscordMessageReceptor] Checking bot ${botInfo.agentName} (${botUserId}): mentioned=${botMentioned}, replyingTo=${replyingToBot}`);

      if (botMentioned) {
        botsToActivate.push({ agentName: botInfo.agentName, reason: 'bot_mentioned' });
      } else if (replyingToBot) {
        botsToActivate.push({ agentName: botInfo.agentName, reason: 'bot_replied_to' });
      }
    }

    // Fallback to single bot if using legacy config
    if (botsToActivate.length === 0 && singleBotUserId) {
      const botMentioned = mentions?.users?.some((u: any) => u.id === singleBotUserId);
      const replyingToBot = reply?.authorId === singleBotUserId;

      if (botMentioned || replyingToBot || fallbackActivate) {
        const reason = botMentioned ? 'bot_mentioned' : replyingToBot ? 'bot_replied_to' : 'fallback_activate';
        botsToActivate.push({ agentName: '', reason });  // Empty agentName = legacy mode
      }
    }

    // Create targeted activations for each bot
    for (const { agentName, reason } of botsToActivate) {
      console.log(`[DiscordMessageReceptor] Creating agent activation for ${agentName || 'default'} (${reason})`);

      const activationOptions: any = {
        id: `activation-${messageId}${agentName ? `-${agentName}` : ''}`,
        priority: 'normal',
        source: 'discord-message',
        sourceAgentId: author.id,
        channelId,
        messageId,
        author,
        streamRef: { streamId, streamType, metadata: { channelId, channelName } }
      };

      // Add targetAgent for multi-bot routing
      if (agentName) {
        activationOptions.targetAgent = agentName;
      }

      this.addOperation({
        type: 'addFacet',
        facet: createAgentActivation(reason, activationOptions)
      });
    }
  }

  private isOlderOrEqual(messageId: string, lastMessageId: string): boolean {
    try {
      return BigInt(messageId) <= BigInt(lastMessageId);
    } catch {
      return false;
    }
  }

  private handleHistorySync(event: SpaceEvent, state: ReadonlyVEILState): void {
    const { channelId, channelName, guildId, guildName, messages } = event.payload as any;

    console.log(`[DiscordMessageReceptor] Syncing ${messages.length} messages for channel ${channelId}`);

    // Build map of current Discord state
    const discordMessages = new Map(messages.map((m: any) => [m.messageId, m]));

    // Find all Discord message facets for this channel in VEIL
    const veilMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' &&
        (f as any).state?.eventType === 'discord-message' &&
        (f as any).attributes?.channelId === channelId
    );

    let deletedCount = 0;
    let editedCount = 0;
    const newMessages: any[] = [];

    console.log(`[DiscordMessageReceptor] Found ${veilMessages.length} existing messages in VEIL, ${messages.length} in history`);

    for (const veilMsg of veilMessages) {
      const messageId = (veilMsg as any).attributes.messageId;
      const speechFacet = (veilMsg as any).children?.[0];
      const veilContent = speechFacet?.content || '';
      const discordMsg = discordMessages.get(messageId) as any;

      if (!discordMsg) {
        // Message was DELETED offline
        console.log(`[DiscordMessageReceptor] Message ${messageId} deleted offline`);
        deletedCount++;

        this.addOperation({ type: 'removeFacet', id: veilMsg.id });
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-delete-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was deleted while offline]`,
            state: { source: 'discord-history-sync', eventType: 'discord-message-deleted-offline', metadata: { messageId, channelId } },
            attributes: { messageId, channelId },
            ephemeral: true
          }
        });
      } else if (this.extractContent(veilContent) !== discordMsg.content) {
        // Message was EDITED offline
        console.log(`[DiscordMessageReceptor] Message ${messageId} edited offline`);
        editedCount++;

        if (speechFacet) {
          this.addOperation({
            type: 'rewriteFacet',
            id: speechFacet.id,
            changes: { content: `${discordMsg.author}: ${discordMsg.content}` }
          });
        }

        this.addOperation({
          type: 'rewriteFacet',
          id: veilMsg.id,
          changes: {
            state: {
              source: 'discord',
              eventType: 'discord-message',
              metadata: { ...((veilMsg as any).state?.metadata || {}), rawContent: discordMsg.rawContent, mentions: discordMsg.mentions }
            },
            attributes: { ...((veilMsg as any).attributes || {}), mentions: discordMsg.mentions }
          }
        });

        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `discord-offline-edit-${messageId}-${Date.now()}`,
            type: 'event',
            content: `[A message was edited while offline]`,
            state: {
              source: 'discord-history-sync',
              eventType: 'discord-message-edited-offline',
              metadata: { messageId, channelId, oldContent: this.extractContent(veilContent), newContent: discordMsg.content }
            },
            attributes: { messageId, channelId }
          }
        });
      }
    }

    // Find messages in Discord history that aren't in VEIL yet
    const veilMessageIds = new Set(veilMessages.map(v => (v as any).attributes.messageId));
    for (const msg of messages) {
      if (!veilMessageIds.has(msg.messageId)) {
        newMessages.push(msg);
      }
    }

    console.log(`[DiscordMessageReceptor] ${editedCount} edits, ${deletedCount} deletions, ${newMessages.length} new messages`);

    // Create a single parent facet for new history messages
    if (newMessages.length > 0) {
      const historyFacetId = `discord-history-${channelId}`;

      // Start with metadata children so agent knows which channel/server this is
      const children: any[] = [
        {
          id: `${historyFacetId}-channel`,
          type: 'metadata',
          displayName: 'channel',
          content: `#${channelName || 'unknown'}`
        },
        {
          id: `${historyFacetId}-server`,
          type: 'metadata',
          displayName: 'server',
          content: guildName || 'unknown'
        }
      ];

      for (const msg of newMessages) {
        const speechFacet = {
          id: `speech-${msg.messageId}`,
          type: 'speech',
          content: msg.content,
          state: { speakerId: `discord:${msg.authorId}`, speaker: msg.author }
        };

        children.push({
          id: `discord-msg-${msg.messageId}`,
          type: 'event',
          state: {
            source: 'discord',
            eventType: 'discord-message',
            metadata: { channelName, author: msg.author, authorId: msg.authorId, isBot: msg.isBot, rawContent: msg.rawContent, mentions: msg.mentions }
          },
          attributes: { channelId, messageId: msg.messageId, mentions: msg.mentions },
          children: [speechFacet]
        });
      }

      // Use stable ID so reconnects update existing history instead of creating duplicates
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: historyFacetId,
          type: 'event',
          displayName: 'discord-history',
          state: { source: 'discord', eventType: 'discord-history-dump', metadata: { channelId, channelName, guildId, guildName, messageCount: newMessages.length } },
          attributes: { channelId, guildId, messageCount: newMessages.length },
          children
        }
      });
    }
  }

  private extractContent(fullContent: string | undefined): string {
    if (!fullContent) return '';
    const match = fullContent.match(/^[^:]+: (.+)$/);
    return match ? match[1] : fullContent;
  }

  private handleMessageUpdate(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { messageId, content, rawContent, oldContent, rawOldContent, mentions, author, authorId, channelName, isBot } = payload;

    console.log(`[DiscordMessageReceptor] Message ${messageId} edited by ${author}`);

    const facetId = `discord-msg-${messageId}`;
    const speechFacetId = `speech-${messageId}`;

    if (state.facets.has(facetId)) {
      if (state.facets.has(speechFacetId)) {
        this.addOperation({
          type: 'rewriteFacet',
          id: speechFacetId,
          changes: { content: `${author}: ${content}` }
        });
      }

      this.addOperation({
        type: 'rewriteFacet',
        id: facetId,
        changes: {
          state: { source: 'discord', eventType: 'discord-message', metadata: { channelName, author, authorId, isBot, rawContent, mentions } },
          attributes: { mentions }
        }
      });

      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-edit-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author} edited their message in #${channelName}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-edited',
            metadata: { messageId, author, authorId, channelName, oldContent, newContent: content, rawOldContent, rawNewContent: rawContent, mentions }
          },
          attributes: { messageId, oldContent, newContent: content, author, mentions }
        }
      });
    }
  }

  private handleMessageDelete(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const { messageId, author, channelName } = payload;

    console.log(`[DiscordMessageReceptor] Message ${messageId} deleted`);

    const facetId = `discord-msg-${messageId}`;

    if (state.facets.has(facetId)) {
      this.addOperation({ type: 'removeFacet', id: facetId });

      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `discord-delete-${messageId}-${Date.now()}`,
          type: 'event',
          content: `${author || 'Someone'} deleted their message in #${channelName || 'a channel'}`,
          state: {
            source: 'discord',
            eventType: 'discord-message-deleted',
            metadata: { messageId, author, channelName, deletedFacetId: facetId }
          },
          attributes: { messageId, author, deletedFacetId: facetId }
        }
      });
    }
  }
}  // End of DiscordMessageReceptor class
/**
 * FLEX Component: Discord Infrastructure
 *
 * Watches for required components to be mounted and triggers DiscordAfferent creation.
 *
 * Constraint: priority 150 (Early transform priority, after receptors at 100)
 */
class DiscordInfrastructureTransform extends Component {
  constraints = [priorityConstraint(150)];

  // Discord configuration (injected via component config)
  // Can be single config (legacy) or array of bot configs (multi-bot)
  private discordConfig?: any;
  private botConfigs?: Array<any>;  // Multi-bot support

  // Agent system prompts to emit as ambient facets (behavioral instructions without identity)
  // Identity is emitted separately when Discord connects
  private agentSystemPrompts?: Array<{ agentName: string; systemPrompt: string }>;

  // Track which components we're waiting for (simplified for merged receptor)
  // Note: AgentComponent is created later in setupDiscordAgent, not in infrastructure
  // Using FocusedContextTransform instead of ContextTransform for multi-bot support
  private requiredComponents = new Set([
    'DiscordMessageReceptor',
    'DiscordEffector',
    'ActionEffector',
    'FocusedContextTransform'
  ]);

  private hasTriggered = false;

  execute(context: ExecutionContext): void {
    if (this.hasTriggered) return;

    // Support both single config (legacy) and multi-bot configs
    const configs = this.botConfigs || (this.discordConfig ? [this.discordConfig] : []);
    if (configs.length === 0) {
      console.log('[DiscordInfrastructure] Waiting for config...');
      return;
    }

    const space = this.space;
    if (!space) {
      console.log('[DiscordInfrastructure] Space not available yet...');
      return;
    }

    const components = space.components || [];
    const mountedTypes = new Set(components.map((c: any) => c.constructor.name));

    const allReady = [...this.requiredComponents].every(type => mountedTypes.has(type));

    if (!allReady) {
      console.log('[DiscordInfrastructure] Waiting for components... Have:', Array.from(mountedTypes), 'Need:', Array.from(this.requiredComponents));
      return;
    }

    // Check if any afferents already exist
    const existingAfferents = components.filter((c: any) => c.constructor.name === 'DiscordAfferent');
    if (existingAfferents.length >= configs.length) {
      console.log(`[DiscordInfrastructure] All ${configs.length} DiscordAfferents already exist, skipping creation`);
      this.hasTriggered = true;
      return;
    }

    console.log(`[DiscordInfrastructure] All components ready - creating ${configs.length} DiscordAfferent(s) via component:add`);
    this.hasTriggered = true;

    // Emit system prompts as ambient facets for each agent
    this.emitSystemPromptFacets();

    // Create one DiscordAfferent per bot config
    for (const config of configs) {
      const botId = config.botId || config.agent || 'default';
      console.log(`[DiscordInfrastructure] Creating DiscordAfferent for bot: ${botId}`);

      this.emit({
        topic: 'component:add',
        timestamp: Date.now(),
        payload: {
          componentType: 'DiscordAfferent',
          componentId: `discord:DiscordAfferent:${botId}`,
          config: {
            host: config.host,
            path: config.path,
            guild: config.guild,
            agent: config.agent,
            botId: config.botId,  // Multi-bot: which bot to connect as
            token: config.token,
            autoJoinChannels: config.autoJoinChannels || [],
            _axonMetadata: {
              moduleUrl: config.moduleUrl,
              manifestUrl: config.manifestUrl
            }
          }
        }
      });
    }
  }

  /**
   * Emit system prompt facets (behavioral instructions without identity)
   * Identity facet is emitted separately when Discord connects
   */
  private emitSystemPromptFacets(): void {
    if (!this.agentSystemPrompts?.length) {
      console.log('[DiscordInfrastructure] No agent system prompts configured');
      return;
    }

    for (const { agentName, systemPrompt } of this.agentSystemPrompts) {
      if (systemPrompt) {
        console.log(`[DiscordInfrastructure] Emitting system prompt for agent: ${agentName}`);

        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `system-prompt:${agentName}`,
            type: 'ambient',
            content: systemPrompt
          }
        });
      }
    }
  }
}

/**
 * FLEX Component: Discord Effector
 *
 * Handles all Discord side effects:
 * - Auto-join channels when connected
 * - Send typing indicators when agent activates
 * - Send agent speech to Discord
 *
 * Constraint: priority 300 (Standard effector priority)
 */
class DiscordEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  // Map of botId -> DiscordAfferent for multi-bot support
  private discordAfferents: Map<string, any> = new Map();
  private channels: string[] = [];

  onMount(): void {
    this.refreshAfferents();
  }

  private refreshAfferents(): void {
    const space = this.space;
    if (!space) return;

    // Find all DiscordAfferent components
    const afferents = space.components.filter((c: any) =>
      c.constructor.name === 'DiscordAfferent'
    );

    for (const afferent of afferents) {
      // Extract botId from component ID (format: discord:DiscordAfferent:botId)
      const componentId = (afferent as any).id || '';
      const botIdMatch = componentId.match(/discord:DiscordAfferent:(.+)/);
      const botId = botIdMatch ? botIdMatch[1] : 'default';
      this.discordAfferents.set(botId, afferent);
      console.log(`[DiscordEffector] Registered afferent for bot: ${botId}`);
    }

    console.log(`[DiscordEffector] Found ${this.discordAfferents.size} DiscordAfferent(s)`);
  }

  private getAfferentForBot(botId: string): any {
    // Try exact match first
    if (this.discordAfferents.has(botId)) {
      return this.discordAfferents.get(botId);
    }
    // Fall back to first available
    if (this.discordAfferents.size > 0) {
      const fallback = this.discordAfferents.values().next().value;
      console.warn(`[DiscordEffector] No afferent for bot ${botId}, using fallback`);
      return fallback;
    }
    return undefined;
  }

  execute(context: ExecutionContext): void {
    const { state, frame } = context;

    // Lazy refresh afferents if none found
    if (this.discordAfferents.size === 0) {
      this.refreshAfferents();
    }

    // Process frame deltas for facets we care about
    if (frame && frame.deltas) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet') {
          const facet = delta.facet;

          // Handle discord:connected - auto-join channels
          if (facet.type === 'event' && (facet as any).state?.eventType === 'discord-connected') {
            this.handleConnected(state);
          }

          // Handle agent-activation - send typing indicator
          if (facet.type === 'agent-activation') {
            this.handleActivation(facet, state);
          }

          // Handle speech - send to Discord
          if (facet.type === 'speech') {
            this.handleSpeech(facet, state);
          }
        }
      }
    }
  }

  private handleConnected(state: ReadonlyVEILState): void {
    // NOTE: Auto-join is handled by DiscordAfferent itself when authenticated.
    // This effector no longer auto-joins to avoid duplicate join commands.
    // The afferent reads autoJoinChannels from component state and joins there.
    console.log('🤖 Discord connected! (auto-join handled by DiscordAfferent)');
  }

  private handleActivation(facet: Facet, state: ReadonlyVEILState): void {
    const activation = facet as any;
    const channelId = activation.state?.channelId || activation.state?.metadata?.channelId;
    const targetAgent = activation.state?.targetAgent || activation.state?.metadata?.targetAgent;

    if (!channelId) return;

    // Get the correct afferent for this bot
    const afferent = this.getAfferentForBot(targetAgent || 'default');
    if (!afferent?.sendTyping) return;

    console.log(`[DiscordEffector] Sending typing indicator to channel: ${channelId} via ${targetAgent || 'default'}`);

    afferent.sendTyping({ channelId }).catch((err: any) =>
      console.error(`Failed to send typing indicator:`, err)
    );
  }

  private handleSpeech(facet: Facet, state: ReadonlyVEILState): void {
    const speech = facet as any;
    const streamId = speech.streamId;
    let content = speech.content;

    // Check if this is for Discord
    if (!streamId || !streamId.startsWith('discord:')) return;

    console.log(`[DiscordEffector] Processing speech for stream: ${streamId}`);
    console.log(`[DiscordEffector] Raw speech content:\n---\n${content}\n---`);
    console.log(`[DiscordEffector] agentName=${speech.agentName}, agentId=${speech.agentId}`);

    // Strip speaker prefix (e.g., "claude-opus-4-5: " or "claude-opus-4: ")
    // The prefix is added by SpeakerPrefixReceptor for internal identification
    const prefixMatch = content.match(/^[^:]+:\s*/);
    if (prefixMatch) {
      content = content.substring(prefixMatch[0].length);
      console.log(`[DiscordEffector] Stripped speaker prefix: "${prefixMatch[0].trim()}"`);
    }

    // Check for reply syntax: <reply:@username> message
    const replyMatch = content.match(/^<reply:@([^>]+)>\s*/);
    let replyToMessageId = null;

    if (replyMatch) {
      const replyToUsername = replyMatch[1];
      content = content.substring(replyMatch[0].length);
      console.log(`[DiscordEffector] Detected reply to @${replyToUsername}`);
      replyToMessageId = this.inferReplyTarget(replyToUsername, speech, state);
    }

    // Find the channel ID from latest discord message
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    );

    if (discordMessages.length === 0) {
      console.warn('[DiscordEffector] No discord-message facets found');
      return;
    }

    const latestMessage = discordMessages[discordMessages.length - 1] as any;
    const channelId = latestMessage.attributes?.channelId;

    if (!channelId) {
      console.warn('[DiscordEffector] No channelId in message facet');
      return;
    }

    const sendParams: any = { channelId, message: content };
    if (replyToMessageId) {
      sendParams.replyTo = replyToMessageId;
      console.log(`[DiscordEffector] Sending as reply to message ${replyToMessageId}`);
    }

    // Get the correct afferent for this bot
    const botId = speech.agentName || speech.agentId || 'default';
    const afferent = this.getAfferentForBot(botId);

    console.log(`[DiscordEffector] Sending to channel ${channelId} via bot ${botId}: "${content}"`);

    if (!afferent) {
      console.error(`[DiscordEffector] No DiscordAfferent available for bot ${botId}`);
      return;
    }

    if (afferent.send && typeof afferent.send === 'function') {
      afferent.send(sendParams)
        .then(() => console.log(`[DiscordEffector] Successfully sent message via ${botId}`))
        .catch((err: any) => console.error(`Failed to send to Discord via ${botId}:`, err));
    } else if (afferent.actions?.has('send')) {
      afferent.actions.get('send')(sendParams)
        .then(() => console.log(`[DiscordEffector] Successfully sent message via ${botId}`))
        .catch((err: any) => console.error(`Failed to send to Discord via ${botId}:`, err));
    }
  }

  private inferReplyTarget(username: string, speech: any, state: ReadonlyVEILState): string | null {
    const discordMessages = Array.from(state.facets.values()).filter(
      f => f.type === 'event' && (f as any).state?.eventType === 'discord-message'
    ) as any[];

    // Heuristic 1: Check the activation event
    const activations = Array.from(state.facets.values()).filter(
      f => f.type === 'agent-activation' && (f as any).state?.streamRef?.streamId === speech.streamId
    ) as any[];

    if (activations.length > 0) {
      const latestActivation = activations[activations.length - 1];
      const triggerMessageId = latestActivation.state?.messageId;
      if (triggerMessageId) {
        const triggerMessage = discordMessages.find(m => m.attributes?.messageId === triggerMessageId);
        if (triggerMessage && triggerMessage.state?.metadata?.author === username) {
          console.log(`[DiscordEffector] Reply target (activation): ${triggerMessageId}`);
          return triggerMessageId;
        }
      }
    }

    // Heuristic 2: Find last message from username that mentioned/replied to bot
    const botConfigFacet = state.facets.get('discord-config-botUserId');
    const botUserId = botConfigFacet?.state?.value;

    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author !== username) continue;

      const mentions = msg.state?.metadata?.mentions;
      if (mentions?.users?.some((u: any) => u.id === botUserId)) {
        console.log(`[DiscordEffector] Reply target (mentioned bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }

      const reply = msg.state?.metadata?.reply;
      if (reply?.authorId === botUserId) {
        console.log(`[DiscordEffector] Reply target (replied to bot): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }

    // Heuristic 3: Find last message from username
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      const msg = discordMessages[i];
      if (msg.state?.metadata?.author === username) {
        console.log(`[DiscordEffector] Reply target (last from user): ${msg.attributes.messageId}`);
        return msg.attributes.messageId;
      }
    }

    console.log(`[DiscordEffector] No reply target found for @${username}`);
    return null;
  }
}


/**
 * Test component that auto-joins Discord channels when connected
 */
@persistable(1)
class DiscordAutoJoinComponent extends Component {
  @persistent() private channels: string[] = [];
  @persistent() private hasJoined: boolean = false;
  
  constructor(channels: string[] = []) {  // No default channel - must be configured
    super();
    this.channels = channels;
  }
  
  onMount(): void {
    // Subscribe to discord connected event
    this.subscribe('discord:connected');
  }
  
  async handleEvent(event: SpaceEvent): Promise<void> {
    console.log('🔔 DiscordAutoJoinComponent received event:', event.topic, 'from:', event.source);
    
    // Always try to join channels on discord:connected
    if (event.topic === 'discord:connected') {
      console.log('🤖 Discord connected! Auto-joining channels:', this.channels);
      
      // Find DiscordAfferent directly in space
      const space = this.space;
      const discordAfferent = space.components.find((c: any) => c.constructor.name === 'DiscordAfferent') as any;
      
      if (discordAfferent) {
        console.log('Found DiscordAfferent');
        for (const channelId of this.channels) {
          console.log(`📢 Requesting to join channel: ${channelId}`);
          
          if (typeof discordAfferent.join === 'function') {
             discordAfferent.join({ channelId });
          }
        }
        this.hasJoined = true;
      } else {
        console.log('DiscordAfferent not found!');
      }
    }
  }
}

export class DiscordApplication implements ConnectomeApplication {
  constructor(private config: DiscordAppConfig) {}
  
  async createSpace(hostRegistry?: Map<string, any>, lifecycleId?: string, spaceId?: string): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId);
    return { space, veilState };
  }
  
  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Discord application (fresh start)...');
    
    // Register all components
    this.getComponentRegistry();

    // Add ComponentManager first - handles component:add events
    // console.log('🔧 Adding ComponentManager...');
    // space.addComponent(new ComponentManager(), 'ComponentManager');
    console.log('🔧 ComponentManager should be provided by Host');

    const modulePort = this.config.discord.modulePort || 8080;
    const moduleUrl = `http://localhost:${modulePort}/modules/discord-afferent/module`;
    const manifestUrl = `http://localhost:${modulePort}/modules/discord-afferent/manifest`;

    // Build bot configs - support both single bot (legacy) and multi-bot
    let botConfigs: Array<any>;
    let agentSystemPrompts: Array<{ agentName: string; systemPrompt: string }>;

    if (this.config.bots && this.config.bots.length > 0) {
      // Multi-bot mode: use bots array
      console.log(`🤖 Multi-bot mode: configuring ${this.config.bots.length} bot(s)`);
      botConfigs = this.config.bots.map(bot => ({
        host: this.config.discord.host,
        path: '/ws',
        guild: bot.guild || this.config.discord.guild,
        agent: bot.agentName,
        botId: bot.botId,
        token: bot.token,
        autoJoinChannels: bot.autoJoinChannels || this.config.discord.autoJoinChannels || [],
        moduleUrl,
        manifestUrl
      }));
      agentSystemPrompts = this.config.bots.map(bot => ({
        agentName: bot.agentName,
        systemPrompt: bot.systemPrompt
      }));
    } else {
      // Legacy single-bot mode
      const botToken = (this.config as any).botToken || '';
      botConfigs = [{
        host: this.config.discord.host,
        path: '/ws',
        guild: this.config.discord.guild,
        agent: this.config.agentName,
        botId: this.config.discord.botId || (this.config as any).botId,
        token: botToken,
        autoJoinChannels: this.config.discord.autoJoinChannels || [],
        moduleUrl,
        manifestUrl
      }];
      agentSystemPrompts = [
        { agentName: this.config.agentName, systemPrompt: this.config.systemPrompt }
      ];
    }

    // STEP 1: Add DiscordInfrastructureTransform (via component:add event to test ComponentManager)
    console.log('🔧 Adding DiscordInfrastructureTransform...');
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordInfrastructureTransform',
        componentId: 'discord:DiscordInfrastructureTransform',
        config: {
          botConfigs,  // Multi-bot configs
          discordConfig: botConfigs[0],  // Keep for backwards compat
          agentSystemPrompts
        }
      }
    });


    // STEP 2: Add FLEX components (merged for performance)
    console.log('➕ Adding Discord FLEX components...');

    // Add merged DiscordMessageReceptor (handles all discord events → facets)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordMessageReceptor',
        componentId: 'discord:DiscordMessageReceptor',
        config: {}
      }
    });

    // Add merged DiscordEffector (handles auto-join, typing, speech)
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'DiscordEffector',
        componentId: 'discord:DiscordEffector',
        config: {
          channels: this.config.discord.autoJoinChannels || []
        }
      }
    });

    // Add ActionEffector and ContextTransform
    // Note: AgentComponent is created later in setupDiscordAgent with proper config
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'ActionEffector',
        componentId: 'discord:ActionEffector',
        config: {}
      }
    });

    // Use FocusedContextTransform for per-agent context filtering and identity injection
    space.emit({
      topic: 'component:add',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        componentType: 'FocusedContextTransform',
        componentId: 'discord:FocusedContextTransform',
        config: {
          maxConversationFrames: 100  // Can be overridden via config.json
        }
      }
    });

    // Wait for infrastructure components to be created
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log('✅ Infrastructure components added - Discord component will be created when ready');

    // Check for existing AgentComponent (unless skipAgentComponent is set)
    if (!(this.config as any).skipAgentComponent) {
      let existingAgentComponent = space.getComponentById('discord-agent:AgentComponent');

      if (!existingAgentComponent) {
        console.log('🆕 Creating agent component');

          const agentConfig = {
            name: this.config.agentName,
            systemPrompt: this.config.systemPrompt,
            autoActionRegistration: true
          };

        space.emit({
          topic: 'component:add',
          source: space.getRef(),
          timestamp: Date.now(),
          payload: {
            componentType: 'AgentComponent',
            componentId: 'discord-agent:AgentComponent',
            config: { agentConfig }
          }
        });

        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        console.log('✅ Found existing agent component');
      }
    } else {
      console.log('⏭️  Skipping AgentComponent creation (using ToolLoopAgent instead)');
    }
    
    // Subscribe to agent response events
    space.subscribe('agent:frame-ready');

    // Load discord-control-panel module via AxonLoader
    let existingControlLoader = space.getComponentById('axon-loader:discord-control-panel');

    if (!existingControlLoader) {
      console.log('📋 Loading Discord control panel module');
      const controlPanelLoader = new AxonLoaderComponent();
      space.addComponent(controlPanelLoader, 'axon-loader:discord-control-panel');
      await controlPanelLoader.connect(`axon://localhost:${modulePort}/modules/discord-control-panel/manifest`);
    } else {
      console.log('✅ Found existing Discord control panel loader');
    }

    // Load component-factory module via AxonLoader
    let existingFactoryLoader = space.getComponentById('axon-loader:component-factory');

    if (!existingFactoryLoader) {
      console.log('🎮 Loading Component factory module');
      const componentFactoryLoader = new AxonLoaderComponent();
      space.addComponent(componentFactoryLoader, 'axon-loader:component-factory');
      await componentFactoryLoader.connect(`axon://localhost:${modulePort}/modules/component-factory/manifest`);
    } else {
      console.log('✅ Found existing Component factory loader');
    }
    
    console.log('✅ Discord application initialized');
  }
  
  getComponentRegistry(): typeof ComponentRegistry {
    const registry = ComponentRegistry;

    // Register all FLEX components
    registry.register('AgentComponent', AgentComponent);
    registry.register('DiscordAutoJoinComponent', DiscordAutoJoinComponent);

    // Register FLEX infrastructure
    registry.register('ComponentManager', ComponentManager);
    registry.register('DiscordInfrastructureTransform', DiscordInfrastructureTransform);

    // Merged FLEX receptor (handles all discord events)
    registry.register('DiscordMessageReceptor', DiscordMessageReceptor);

    // Merged FLEX effector (handles auto-join, typing, speech)
    registry.register('DiscordEffector', DiscordEffector);

    // Register FocusedContextTransform to replace generic ContextTransform
    // This provides per-agent context filtering and identity injection
    registry.register('FocusedContextTransform', FocusedContextTransform);

    // Core components (AgentComponent, ActionEffector, ContextTransform, AxonLoaderComponent
    // are registered in connectome-ts core-components.ts)

    return registry;
  }
  
  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Discord application started!');
    console.log('✅ Discord application ready - waiting for infrastructure to create Discord component');
  }
  
  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️ Discord application restored from snapshot');
    console.log('✅ All connections re-established after restoration');
  }
}
