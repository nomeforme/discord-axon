/**
 * Agent Runner for Discord AXON gRPC mode
 *
 * Handles running the local ToolLoopAgent when a message triggers activation.
 * This replaces the server-side activation pattern with client-side execution.
 */

import type { Client, Guild, TextChannel } from 'discord.js';
import { renderContext, buildMinimalContext } from './context-renderer.js';
import { cleanSpeechContent, resolveMentions, splitMessage } from './utils/index.js';
import type { DiscordGrpcClient } from './client.js';
import type { ToolLoopAgent } from '../tool-loop-agent.js';
import type { BotConfig } from './types.js';

/**
 * Configuration for agent execution
 */
export interface AgentRunnerConfig {
  maxFrames: number;
  maxTokens: number;
}

const DEFAULT_CONFIG: AgentRunnerConfig = {
  maxFrames: 100,
  maxTokens: 50000
};

/**
 * Run the agent for a message and send the response to Discord
 *
 * @param options - Execution options
 * @returns true if agent ran successfully, false otherwise
 */
export async function runAgentForMessage(options: {
  /** The ToolLoopAgent to run */
  agent: ToolLoopAgent;
  /** Bot configuration */
  botConfig: BotConfig;
  /** gRPC client for server communication */
  grpcClient: DiscordGrpcClient;
  /** Discord client for sending messages */
  discordClient: Client;
  /** Stream ID (channel identifier) */
  streamId: string;
  /** Channel ID for sending response */
  channelId: string;
  /** Map of bot user IDs to names (for mention resolution) */
  botUserIdToName: Map<string, string>;
  /** Message content (for fallback context) */
  messageContent: string;
  /** Message author name (for fallback context) */
  authorName: string;
  /** Optional config overrides */
  config?: Partial<AgentRunnerConfig>;
}): Promise<boolean> {
  const {
    agent,
    botConfig,
    grpcClient,
    discordClient,
    streamId,
    channelId,
    botUserIdToName,
    messageContent,
    authorName,
    config = {}
  } = options;

  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const botName = botConfig.name;

  console.log(`[AgentRunner] Running agent ${botName} for stream ${streamId}`);

  // Send typing indicator
  let typingInterval: NodeJS.Timeout | undefined;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await channel.sendTyping();
      console.log(`[AgentRunner] Sent typing indicator to channel ${channelId}`);

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
    console.warn(`[AgentRunner] Failed to send typing indicator:`, error.message);
  }

  try {
    // Fetch and render context from server
    let renderedContext;
    try {
      renderedContext = await renderContext(
        grpcClient,
        streamId,
        botName,
        botConfig.prompt,
        {
          maxFrames: fullConfig.maxFrames,
          maxTokens: fullConfig.maxTokens
        }
      );
    } catch (contextError: any) {
      console.warn(`[AgentRunner] Context fetch failed, using minimal context:`, contextError.message);
      renderedContext = buildMinimalContext(botName, messageContent, authorName, botConfig.prompt);
    }

    // Build stream reference
    const streamRef = { streamId, streamType: 'discord' };

    // Run the agent (cast to any since ToolLoopAgent only uses messages array)
    const response = await agent.runCycle(renderedContext as any, streamRef);

    console.log(`[AgentRunner] Agent ${botName} returned ${response.operations.length} operations, content length: ${response.content.length}`);

    // Send response to Discord
    if (response.content) {
      let cleanedContent = cleanSpeechContent(response.content);

      if (cleanedContent) {
        const channel = await discordClient.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          // Resolve mentions
          const guild = 'guild' in channel ? (channel as TextChannel).guild : undefined;
          cleanedContent = await resolveMentions(
            cleanedContent,
            guild as Guild | undefined,
            botUserIdToName
          );

          // Split and send
          const chunks = splitMessage(cleanedContent, 2000);
          for (const chunk of chunks) {
            await channel.send(chunk);
          }
          console.log(`[AgentRunner] Sent response (${chunks.length} chunk(s))`);

          // Record speech in server state
          try {
            await grpcClient.emitEvent(
              'agent:speech',
              {
                content: cleanedContent,
                agentId: botName,
                agentName: botName,
                streamId,
                channelId,
                timestamp: Date.now()
              },
              { priority: 'normal', waitForFrame: true }
            );
            console.log(`[AgentRunner] Recorded speech in server state`);
          } catch (speechError: any) {
            console.warn(`[AgentRunner] Failed to record speech:`, speechError.message);
          }
        }
      }
    }

    return true;
  } catch (error: any) {
    console.error(`[AgentRunner] Error running agent ${botName}:`, error.message);
    console.error(error.stack);
    return false;
  } finally {
    // Stop typing indicator
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}
