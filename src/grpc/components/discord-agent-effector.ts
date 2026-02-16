/**
 * DiscordAgentEffector - gRPC equivalent of the non-gRPC DiscordAgentEffector
 *
 * Processes agent activations with native tool support:
 * 1. Receives activation trigger from DiscordMessageReceptor
 * 2. Fetches context via FocusedContextTransform
 * 3. Runs ToolLoopAgent cycle
 * 4. Sends response to Discord
 * 5. Records speech in Connectome server state
 *
 * This is the gRPC client-side equivalent - it runs the agent locally
 * and communicates results back to the server.
 */

import type { Client, Guild, TextChannel } from 'discord.js';
import { cleanSpeechContent, resolveMentions, splitMessage } from '../utils/index.js';
import type { DiscordGrpcClient } from '../client.js';
import { type ConnectomeAgent, renderedContextToAgentContext } from '@connectome/agent-core';
import type { BotConfig } from '../types.js';
import type { FocusedContextTransform } from './focused-context-transform.js';

export interface DiscordAgentEffectorConfig {
  agent: ConnectomeAgent;
  botConfig: BotConfig;
  grpcClient: DiscordGrpcClient;
  discordClient: Client;
  contextTransform: FocusedContextTransform;
  botUserIdToName: Map<string, string>;
  maxMessageLength?: number;
}

export interface AgentActivation {
  streamId: string;
  channelId: string;
  messageContent: string;
  authorName: string;
}

/**
 * DiscordAgentEffector - Runs agent cycles and sends responses
 *
 * Constraint equivalent: EFFECTOR priority (runs after transforms to produce side effects)
 */
export class DiscordAgentEffector {
  private agent: ConnectomeAgent;
  private botConfig: BotConfig;
  private grpcClient: DiscordGrpcClient;
  private discordClient: Client;
  private contextTransform: FocusedContextTransform;
  private botUserIdToName: Map<string, string>;
  private maxMessageLength?: number;
  private processingActivations = new Set<string>();

  constructor(config: DiscordAgentEffectorConfig) {
    this.agent = config.agent;
    this.botConfig = config.botConfig;
    this.grpcClient = config.grpcClient;
    this.discordClient = config.discordClient;
    this.contextTransform = config.contextTransform;
    this.botUserIdToName = config.botUserIdToName;
    this.maxMessageLength = config.maxMessageLength;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.botConfig.name;
  }

  /**
   * Run agent cycle for an activation
   */
  async runAgentCycle(activation: AgentActivation): Promise<boolean> {
    const { streamId, channelId, messageContent, authorName } = activation;
    const botName = this.botConfig.name;
    const activationId = `${streamId}-${Date.now()}`;

    // Skip if already processing this stream
    if (this.processingActivations.has(streamId)) {
      console.log(`[DiscordAgentEffector:${botName}] Already processing activation for stream ${streamId}, skipping`);
      return false;
    }

    this.processingActivations.add(streamId);
    console.log(`[DiscordAgentEffector:${botName}] Running agent cycle for activation ${activationId}...`);

    // Send typing indicator
    let typingInterval: NodeJS.Timeout | undefined;
    try {
      const channel = await this.discordClient.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await channel.sendTyping();
        console.log(`[DiscordAgentEffector:${botName}] Sent typing indicator to channel ${channelId}`);

        // Keep refreshing typing indicator while processing
        typingInterval = setInterval(async () => {
          try {
            await channel.sendTyping();
          } catch {
            if (typingInterval) clearInterval(typingInterval);
          }
        }, 8000);
      }
    } catch (error: any) {
      console.warn(`[DiscordAgentEffector:${botName}] Failed to send typing indicator:`, error.message);
    }

    try {
      // Fetch and render context via FocusedContextTransform
      // Note: emitDiscordMessage uses waitForFrame:true, so attachments should be in server context
      // Following signal-axon pattern: single source of truth from server context, no manual injection
      let renderedContext;
      try {
        renderedContext = await this.contextTransform.renderContext(streamId);
      } catch (contextError: any) {
        console.warn(`[DiscordAgentEffector:${botName}] Context fetch failed, using fallback:`, contextError.message);
        renderedContext = this.contextTransform.buildFallbackContext(messageContent, authorName);
      }

      // Build stream reference
      const streamRef = { streamId, streamType: 'discord' };

      // Convert to pi-agent context and run the agent cycle
      const agentContext = renderedContextToAgentContext(renderedContext);
      const result = await this.agent.runWithContext(agentContext, streamRef);

      console.log(`[DiscordAgentEffector:${botName}] Agent cycle completed with ${result.operations.length} operations, content length: ${result.content.length}`);

      // Send response to Discord
      if (result.content) {
        await this.sendSpeechToDiscord(result.content, channelId, streamId);
      }

      return true;
    } catch (error: any) {
      console.error(`[DiscordAgentEffector:${botName}] Agent cycle error:`, error.message);
      console.error(error.stack);

      // Emit error as speech so it appears in Discord
      await this.emitErrorSpeech(error.message, channelId, streamId);

      return false;
    } finally {
      // Stop typing indicator
      if (typingInterval) {
        clearInterval(typingInterval);
      }
      this.processingActivations.delete(streamId);
    }
  }

  /**
   * Send speech to Discord channel
   */
  private async sendSpeechToDiscord(
    content: string,
    channelId: string,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;

    // Clean speech content (strip XML tags, etc.)
    let cleanedContent = cleanSpeechContent(content);
    if (!cleanedContent) return;

    try {
      const channel = await this.discordClient.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        // Resolve mentions
        const guild = 'guild' in channel ? (channel as TextChannel).guild : undefined;
        cleanedContent = await resolveMentions(
          cleanedContent,
          guild as Guild | undefined,
          this.botUserIdToName
        );

        // Split and send
        const chunks = splitMessage(cleanedContent, this.maxMessageLength);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
        console.log(`[DiscordAgentEffector:${botName}] Sent response (${chunks.length} chunk(s))`);

        // Record speech in server state
        await this.recordSpeechOnServer(cleanedContent, channelId, streamId);
      }
    } catch (error: any) {
      console.error(`[DiscordAgentEffector:${botName}] Error sending to Discord:`, error.message);
    }
  }

  /**
   * Record speech in Connectome server state
   */
  private async recordSpeechOnServer(
    content: string,
    channelId: string,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;

    try {
      await this.grpcClient.emitEvent(
        'agent:speech',
        {
          content,
          agentId: botName,
          agentName: botName,
          streamId,
          channelId,
          timestamp: Date.now()
        },
        { priority: 'normal', waitForFrame: true }
      );
      console.log(`[DiscordAgentEffector:${botName}] Recorded speech in server state`);
    } catch (speechError: any) {
      console.warn(`[DiscordAgentEffector:${botName}] Failed to record speech:`, speechError.message);
    }
  }

  /**
   * Emit error as speech so it shows up in Discord
   */
  private async emitErrorSpeech(
    errorMessage: string,
    channelId: string,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;

    try {
      const channel = await this.discordClient.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await channel.send(`Error: ${errorMessage}`);
      }
    } catch (error: any) {
      console.error(`[DiscordAgentEffector:${botName}] Failed to send error message:`, error.message);
    }
  }
}
