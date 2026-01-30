/**
 * Context Renderer for Discord AXON gRPC mode
 *
 * Fetches context from the server and transforms it into the format
 * expected by ToolLoopAgent. Injects bot identity into system prompt.
 */

import type { DiscordGrpcClient } from './client.js';

/**
 * Message format expected by ToolLoopAgent
 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Rendered context format expected by ToolLoopAgent
 */
export interface RenderedContext {
  messages: ContextMessage[];
  metadata?: {
    totalTokens?: number;
    frameCount?: number;
  };
}

/**
 * Configuration for context rendering
 */
export interface ContextRendererConfig {
  /** Maximum frames to fetch from server */
  maxFrames: number;
  /** Maximum tokens for context */
  maxTokens: number;
}

const DEFAULT_CONFIG: ContextRendererConfig = {
  maxFrames: 100,
  maxTokens: 50000
};

/**
 * Build system prompt with bot identity
 */
function buildSystemPrompt(botName: string, basePrompt?: string): string {
  const identityPrompt = `You are <${botName}> in Discord.

To mention users or other bots, use <@username> syntax. The system will convert usernames to Discord IDs automatically.`;

  if (basePrompt && basePrompt !== 'Standard') {
    return `${basePrompt}\n\n${identityPrompt}`;
  }

  return identityPrompt;
}

/**
 * Transform server context to RenderedContext format
 */
function transformServerContext(
  serverContext: any,
  botName: string,
  systemPrompt?: string
): RenderedContext {
  const messages: ContextMessage[] = [];

  // Add system message with bot identity
  messages.push({
    role: 'system',
    content: buildSystemPrompt(botName, systemPrompt)
  });

  // Transform conversation to messages
  if (serverContext?.conversation && Array.isArray(serverContext.conversation)) {
    for (const msg of serverContext.conversation) {
      // Skip internal messages
      if (msg.internal) continue;

      // Map role (server uses same roles)
      const role = msg.role as 'system' | 'user' | 'assistant';

      // Skip system messages from server (we add our own)
      if (role === 'system') continue;

      messages.push({
        role,
        content: msg.content || ''
      });
    }
  }

  return {
    messages,
    metadata: {
      frameCount: serverContext?.metadata?.frameCount || 0
    }
  };
}

/**
 * Render context for a bot from server state
 *
 * @param grpcClient - The gRPC client to fetch context from
 * @param streamId - The stream (channel) to get context for
 * @param botName - The bot's name for identity injection
 * @param systemPrompt - Optional base system prompt
 * @param config - Optional configuration
 */
export async function renderContext(
  grpcClient: DiscordGrpcClient,
  streamId: string,
  botName: string,
  systemPrompt?: string,
  config: Partial<ContextRendererConfig> = {}
): Promise<RenderedContext> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  try {
    // Fetch context from server
    const serverContext = await grpcClient.getContext(streamId, {
      maxFrames: fullConfig.maxFrames,
      maxTokens: fullConfig.maxTokens
    });

    console.log(`[ContextRenderer] Fetched context for ${botName} on stream ${streamId}`);

    // Transform to RenderedContext format
    const renderedContext = transformServerContext(serverContext, botName, systemPrompt);

    console.log(`[ContextRenderer] Rendered ${renderedContext.messages.length} messages`);

    return renderedContext;
  } catch (error: any) {
    console.error(`[ContextRenderer] Error fetching context:`, error.message);

    // Return minimal context on error
    return {
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(botName, systemPrompt)
        }
      ],
      metadata: {
        frameCount: 0
      }
    };
  }
}

/**
 * Build a minimal context without server fetch
 * Used when server context is not available
 */
export function buildMinimalContext(
  botName: string,
  userMessage: string,
  authorName: string,
  systemPrompt?: string
): RenderedContext {
  return {
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(botName, systemPrompt)
      },
      {
        role: 'user',
        content: `<${authorName}> ${userMessage}`
      }
    ],
    metadata: {
      frameCount: 1
    }
  };
}
