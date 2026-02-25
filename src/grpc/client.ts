/**
 * Discord AXON gRPC Client
 * Connects discord-axon to the central Connectome gRPC server
 */

import { ConnectomeClient, type ConnectomeClientConfig, type SubscriptionOptions, type FacetDelta } from '@connectome/grpc-common';
import { EventEmitter } from 'events';

/**
 * Discord-specific gRPC client configuration
 */
export interface DiscordGrpcClientConfig {
  /** Connectome gRPC server host */
  serverHost: string;
  /** Connectome gRPC server port */
  serverPort?: number;
  /** Client identifier */
  clientId: string;
  /** Bot name for agent registration */
  botName: string;
  /** Guild ID (optional, for multi-guild bots) */
  guildId?: string;
}

/**
 * Discord gRPC Client
 * Wraps ConnectomeClient with Discord-specific functionality
 */
export class DiscordGrpcClient extends EventEmitter {
  private client: ConnectomeClient;
  private config: DiscordGrpcClientConfig;
  private agentHandle?: { agentId: string; sessionToken: string };
  private unsubscribe?: () => void;

  constructor(config: DiscordGrpcClientConfig) {
    super();

    this.config = {
      ...config,
      serverPort: config.serverPort || 50051
    };

    const clientConfig: ConnectomeClientConfig = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      clientId: this.config.clientId,
      reconnectInterval: 5000,
      maxReconnectAttempts: -1 // Infinite reconnect
    };

    this.client = new ConnectomeClient(clientConfig);

    // Forward connection events
    this.client.on('connected', () => this.emit('connected'));
    this.client.on('disconnected', () => this.emit('disconnected'));
    this.client.on('reconnected', () => this.emit('reconnected'));
    this.client.on('reconnect_failed', () => this.emit('reconnect_failed'));
    this.client.on('error', (error) => this.emit('error', error));
  }

  /**
   * Connect to the Connectome server and register as an agent
   */
  async connect(): Promise<void> {
    console.log(`[DiscordGrpcClient] Connecting to ${this.config.serverHost}:${this.config.serverPort}...`);

    await this.client.connect();

    // Register as an agent
    const result = await this.client.registerAgent(
      `agent-${this.config.clientId}`,
      this.config.botName,
      {
        agentType: 'discord-bot',
        capabilities: ['send-message', 'receive-message', 'slash-commands', 'reactions'],
        metadata: {
          clientId: this.config.clientId,
          guildId: this.config.guildId || '',
          streamType: 'discord'
        }
      }
    );

    if (!result.success) {
      throw new Error(`Failed to register agent: ${result.error}`);
    }

    this.agentHandle = {
      agentId: result.agentId,
      sessionToken: result.sessionToken
    };

    console.log(`[DiscordGrpcClient] Registered agent: ${result.agentId}`);
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.client.disconnect();
    this.agentHandle = undefined;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Emit a Discord message event
   */
  async emitDiscordMessage(message: {
    content: string;
    authorId: string;
    authorName: string;
    authorTag?: string;
    channelId: string;
    channelName?: string;
    guildId?: string;
    guildName?: string;
    messageId: string;
    timestamp: number;
    attachments?: any[];
    mentions?: any[];
    replyTo?: {
      messageId?: string;
      channelId?: string;
      authorId?: string;
      author?: string;
    };
    metadata?: Record<string, any>;
    targetBotName?: string;  // Bot that should handle this message (if mentioned)
  }): Promise<{ success: boolean; sequence: number }> {
    // Create stream ID from channel
    const streamId = message.guildId
      ? `discord:${message.guildId}:${message.channelId}`
      : `discord:dm:${message.channelId}`;

    const result = await this.client.emitEvent(
      'discord:message',
      {
        ...message,
        streamId,
        streamType: 'discord'
      },
      {
        priority: 'high',
        waitForFrame: true,
        metadata: {
          channelId: message.channelId,
          streamId
        }
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Emit a Discord connected event (registers bot mapping on server)
   */
  async emitDiscordConnected(connected: {
    botUserId: string;
    botId: string;
    botUsername: string;
    botDisplayName: string;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'discord:connected',
      connected,
      {
        priority: 'normal',
        waitForFrame: true
      }
    );

    return { success: result.success };
  }

  /**
   * Emit a Discord interaction event (slash commands, buttons)
   */
  async emitDiscordInteraction(interaction: {
    type: 'slash-command' | 'button' | 'select-menu' | 'modal';
    customId?: string;
    commandName?: string;
    options?: any[];
    userId: string;
    userName: string;
    channelId: string;
    guildId?: string;
    interactionId: string;
    timestamp: number;
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; sequence: number }> {
    const streamId = interaction.guildId
      ? `discord:${interaction.guildId}:${interaction.channelId}`
      : `discord:dm:${interaction.channelId}`;

    const result = await this.client.emitEvent(
      `discord:interaction:${interaction.type}`,
      {
        ...interaction,
        streamId,
        streamType: 'discord'
      },
      {
        priority: 'high',
        waitForFrame: true
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Emit a Discord reaction event
   */
  async emitDiscordReaction(reaction: {
    emoji: string;
    userId: string;
    messageId: string;
    channelId: string;
    guildId?: string;
    added: boolean;
    timestamp: number;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'discord:reaction',
      reaction,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Emit a Discord presence event
   */
  async emitDiscordPresence(presence: {
    userId: string;
    status: 'online' | 'idle' | 'dnd' | 'offline';
    activity?: any;
    guildId?: string;
    timestamp: number;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'discord:presence',
      presence,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Subscribe to speech facets for outgoing messages
   */
  subscribeToSpeech(
    callback: (facet: any) => void,
    options?: {
      streamIds?: string[];
      agentName?: string;
    }
  ): () => void {
    const subOptions: SubscriptionOptions = {
      filters: [
        {
          types: ['speech'],
          aspectMatch: options?.agentName ? { agentName: options.agentName } : {}
        }
      ],
      includeExisting: false,
      streamIds: options?.streamIds || []
    };

    this.unsubscribe = this.client.subscribe(subOptions, (delta: FacetDelta) => {
      if (delta.type === 'added' && delta.facet) {
        callback(delta.facet);
      }
    });

    return this.unsubscribe;
  }

  /**
   * Subscribe to action facets (for tool use)
   */
  subscribeToActions(
    callback: (facet: any) => void,
    options?: {
      streamIds?: string[];
      toolNames?: string[];
    }
  ): () => void {
    const subOptions: SubscriptionOptions = {
      filters: [
        { types: ['action'] }
      ],
      includeExisting: false,
      streamIds: options?.streamIds || []
    };

    const unsub = this.client.subscribe(subOptions, (delta: FacetDelta) => {
      if (delta.type === 'added' && delta.facet) {
        // Filter by tool name if specified
        if (options?.toolNames && options.toolNames.length > 0) {
          const toolName = delta.facet.state?.toolName;
          if (!toolName || !options.toolNames.includes(toolName)) {
            return;
          }
        }
        callback(delta.facet);
      }
    });

    return unsub;
  }

  /**
   * Subscribe to agent-activation facets (for running agent locally)
   */
  subscribeToActivations(
    callback: (facet: any, context: any) => void,
    options?: {
      streamIds?: string[];
      agentName?: string;
    }
  ): () => void {
    const subOptions: SubscriptionOptions = {
      filters: [
        { types: ['agent-activation'] },
        { types: ['rendered-context'] }
      ],
      includeExisting: false,
      streamIds: options?.streamIds || []
    };

    // Track activations and their contexts BY ACTIVATION ID (not streamId!)
    // This prevents cross-contamination when multiple bots are activated on the same stream
    const pendingActivations = new Map<string, any>();  // activationId -> facet
    const pendingContexts = new Map<string, any>();     // activationId -> context facet

    const unsub = this.client.subscribe(subOptions, (delta: FacetDelta) => {
      if (delta.type !== 'added' || !delta.facet) return;

      const facet = delta.facet;

      if (facet.type === 'agent-activation') {
        const activationId = facet.id;

        // Check if we already have context for THIS SPECIFIC activation
        const context = pendingContexts.get(activationId);

        if (context) {
          pendingContexts.delete(activationId);
          callback(facet, context);
        } else {
          // Store activation by its ID, wait for its specific context
          pendingActivations.set(activationId, facet);

          // Clean up old activations after 30 seconds
          setTimeout(() => pendingActivations.delete(activationId), 30000);
        }
      } else if (facet.type === 'rendered-context') {
        // Get the activationId this context was rendered for
        const activationId = facet.state?.activationId;

        if (!activationId) {
          console.warn('[DiscordGrpcClient] Received rendered-context without activationId, skipping');
          return;
        }

        // Check if we have the pending activation for this context
        const activation = pendingActivations.get(activationId);

        if (activation) {
          pendingActivations.delete(activationId);
          callback(activation, facet);
        } else {
          // Store context by activationId, wait for the activation
          pendingContexts.set(activationId, facet);

          // Clean up old contexts after 30 seconds
          setTimeout(() => pendingContexts.delete(activationId), 30000);
        }
      }
    });

    return unsub;
  }

  /**
   * Get rendered context for the agent
   */
  async getContext(
    streamId: string,
    options?: {
      maxFrames?: number;
    }
  ): Promise<any> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.getContext(
      this.agentHandle.agentId,
      streamId,
      {
        maxFrames: options?.maxFrames || 100
      }
    );

    return result.context;
  }

  /**
   * Create or get a stream for a channel
   */
  async ensureStream(
    channelId: string,
    metadata?: {
      channelName?: string;
      guildId?: string;
      guildName?: string;
      channelType?: string;
    }
  ): Promise<string> {
    const streamId = metadata?.guildId
      ? `discord:${metadata.guildId}:${channelId}`
      : `discord:dm:${channelId}`;

    await this.client.createStream(streamId, 'discord', {
      channelId,
      channelName: metadata?.channelName || '',
      channelType: metadata?.channelType || 'text',
      guildId: metadata?.guildId || '',
      guildName: metadata?.guildName || ''
    });

    return streamId;
  }

  /**
   * Activate agent for a stream
   */
  async activateAgent(
    streamId: string,
    reason?: string,
    metadata?: Record<string, string>
  ): Promise<{ success: boolean; activationId: string }> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.activateAgent(
      this.agentHandle.agentId,
      streamId,
      {
        reason: reason || 'discord message received',
        priority: 'normal',
        metadata
      }
    );

    return {
      success: result.success,
      activationId: result.activationId
    };
  }

  /**
   * Get current health status
   */
  async health(): Promise<{
    healthy: boolean;
    currentSequence: number;
  }> {
    const status = await this.client.health();
    return {
      healthy: status.healthy,
      currentSequence: status.currentSequence
    };
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string | undefined {
    return this.agentHandle?.agentId;
  }

  /**
   * Emit a generic event to the server
   * Used for agent:speech and other custom events
   */
  async emitEvent(
    topic: string,
    payload: Record<string, any>,
    options?: {
      priority?: 'immediate' | 'high' | 'normal' | 'low';
      waitForFrame?: boolean;
    }
  ): Promise<{ success: boolean; sequence: number }> {
    const result = await this.client.emitEvent(topic, payload, options);
    return {
      success: result.success,
      sequence: result.sequence
    };
  }
}
