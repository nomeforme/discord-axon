/**
 * FocusedContextTransform - gRPC equivalent of the non-gRPC FocusedContextTransform
 *
 * Fetches and renders per-agent context from the Connectome server:
 * 1. Fetches VEIL state via gRPC GetContext
 * 2. Transforms server facets into LLM-compatible messages
 * 3. Injects bot identity into system prompt
 * 4. Filters by stream (channel) to avoid cross-channel pollution
 *
 * This is the gRPC client-side equivalent - it fetches context from
 * the server rather than accessing VEILStateManager directly.
 */

import type { DiscordGrpcClient } from '../client.js';
import { resolveIncomingMentions } from '../utils/mention-resolver.js';

/**
 * Message format for LLM context
 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  metadata?: {
    attachments?: Array<{
      id?: string;
      url?: string;
      contentType?: string;
      name?: string;
      size?: number;
      data?: string;  // base64 encoded
    }>;
  };
}

/**
 * Rendered context for the agent
 */
export interface RenderedContext {
  messages: ContextMessage[];
  metadata: {
    totalTokens?: number;
    frameCount: number;
    streamId?: string;
  };
}

export interface FocusedContextTransformConfig {
  grpcClient: DiscordGrpcClient;
  botName: string;
  systemPrompt: string;
  maxConversationFrames: number;
  botUserIdToName: Map<string, string>;
  skipIdentityPrompt?: boolean;
}

/**
 * FocusedContextTransform - Renders context for agent activation
 *
 * Constraint equivalent: priority 100 (runs after receptors to transform state)
 */
export class FocusedContextTransform {
  private grpcClient: DiscordGrpcClient;
  private botName: string;
  private systemPrompt: string;
  private maxConversationFrames: number;
  private botUserIdToName: Map<string, string>;
  private skipIdentityPrompt: boolean;

  constructor(config: FocusedContextTransformConfig) {
    this.grpcClient = config.grpcClient;
    this.botName = config.botName;
    this.systemPrompt = config.systemPrompt;
    this.maxConversationFrames = config.maxConversationFrames;
    this.botUserIdToName = config.botUserIdToName;
    this.skipIdentityPrompt = config.skipIdentityPrompt ?? false;
  }

  /**
   * Update max conversation frames (for runtime config changes)
   */
  setMaxConversationFrames(value: number): void {
    this.maxConversationFrames = value;
    console.log(`[FocusedContextTransform:${this.botName}] maxConversationFrames set to ${value}`);
  }

  /**
   * Render context for the agent
   *
   * Fetches context from the server and transforms it into LLM messages.
   */
  async renderContext(
    streamId: string,
    options?: {
      maxFrames?: number;
    }
  ): Promise<RenderedContext> {
    const maxFrames = options?.maxFrames ?? this.maxConversationFrames;

    console.log(`[FocusedContextTransform:${this.botName}] Fetching context for stream ${streamId} (maxFrames=${maxFrames})`);

    try {
      // Fetch context from server via gRPC
      const serverContext = await this.grpcClient.getContext(streamId, {
        maxFrames
      });

      console.log(`[FocusedContextTransform:${this.botName}] Received context from server`);

      // Transform server context to LLM messages
      const messages = this.transformToMessages(serverContext);

      // Log conversation data before sending to LLM
      this.logConversationData(messages, streamId);

      return {
        messages,
        metadata: {
          frameCount: serverContext?.metadata?.frameCount || 0,
          streamId
        }
      };
    } catch (error: any) {
      console.warn(`[FocusedContextTransform:${this.botName}] Context fetch failed:`, error.message);

      // Return minimal context on error
      return this.buildMinimalContext();
    }
  }

  /**
   * Transform server context to LLM messages
   */
  private transformToMessages(serverContext: any): ContextMessage[] {
    const messages: ContextMessage[] = [];

    // Build system prompt with bot identity
    const systemContent = this.buildSystemPrompt();
    messages.push({
      role: 'system',
      content: systemContent
    });

    // Transform conversation from server
    if (serverContext?.conversation && Array.isArray(serverContext.conversation)) {
      for (const msg of serverContext.conversation) {
        // Skip internal messages (thoughts)
        if (msg.internal) continue;

        const role = msg.role as 'system' | 'user' | 'assistant';

        // Skip system messages from server (we add our own)
        if (role === 'system') continue;

        if (role === 'user' || role === 'assistant') {
          // Resolve Discord mention IDs (<@123456>) to readable @name format
          const resolvedContent = resolveIncomingMentions(
            msg.content || '',
            this.botUserIdToName
          );

          const message: ContextMessage = {
            role,
            content: resolvedContent
          };

          // Preserve attachment metadata for LLM image processing
          if (msg.metadata?.attachments && Array.isArray(msg.metadata.attachments) && msg.metadata.attachments.length > 0) {
            message.metadata = {
              attachments: msg.metadata.attachments
            };
          }

          messages.push(message);
        }
      }
    }

    console.log(`[FocusedContextTransform:${this.botName}] Transformed ${messages.length} messages`);

    return messages;
  }

  /**
   * Build system prompt with bot identity and Discord capabilities
   */
  private buildSystemPrompt(): string {
    const identityPrompt = this.skipIdentityPrompt ? '' : `You are <${this.botName}> in Discord.

To mention users or other bots, use @username syntax (e.g. @claude-opus-4-5). The system will convert usernames to Discord mentions automatically.`;

    if (this.systemPrompt && this.systemPrompt !== 'Standard') {
      if (identityPrompt) {
        // Identity first, custom persona after — identity/mention rules sit at the
        // head where models weight instructions most heavily, before the persona
        // takes over. Critical for smaller/local models (Qwen etc.) that otherwise
        // drop trailing meta-instructions behind a strong character prompt.
        return `${identityPrompt}\n\n${this.systemPrompt}`;
      }
      return this.systemPrompt;
    }

    return identityPrompt;
  }

  /**
   * Build minimal context when server is unavailable
   */
  private buildMinimalContext(): RenderedContext {
    return {
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt()
        }
      ],
      metadata: {
        frameCount: 0
      }
    };
  }

  /**
   * Build fallback context with a single user message
   * Used when server context is not available
   */
  buildFallbackContext(messageContent: string, authorName: string): RenderedContext {
    return {
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt()
        },
        {
          role: 'user',
          content: `<${authorName}> ${messageContent}`
        }
      ],
      metadata: {
        frameCount: 1
      }
    };
  }

  /**
   * Log conversation data before sending to LLM (last 10 messages only)
   */
  private logConversationData(messages: ContextMessage[], streamId: string): void {
    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════`);
    console.log(`║ [FocusedContextTransform:${this.botName}] CONVERSATION DATA FOR LLM`);
    console.log(`║ Stream: ${streamId}`);
    console.log(`║ Total messages: ${messages.length} (showing last 10)`);
    console.log(`╠══════════════════════════════════════════════════════════════════════════════`);

    // Show only the last 10 messages
    const startIndex = Math.max(0, messages.length - 10);
    if (startIndex > 0) {
      console.log(`║ ... (${startIndex} earlier messages omitted)`);
    }

    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      const roleLabel = msg.role.toUpperCase().padEnd(9);
      const contentPreview = msg.content.length > 200
        ? msg.content.substring(0, 200) + '...'
        : msg.content;

      // Replace newlines with visible marker for compact display
      const displayContent = contentPreview.replace(/\n/g, ' ↵ ');

      console.log(`║ [${i + 1}] ${roleLabel}: ${displayContent}`);

      // Log attachment info if present (without raw base64 data)
      if (msg.metadata?.attachments && msg.metadata.attachments.length > 0) {
        for (const att of msg.metadata.attachments as any[]) {
          const dataSize = att.data ? `${Math.round(att.data.length / 1024)}KB base64` : (att.url ? 'URL' : 'no data');
          console.log(`║     └─ 📎 ${att.name || att.filename || att.id || 'attachment'} (${att.contentType}, ${dataSize})`);
        }
      }
    }

    console.log(`╚══════════════════════════════════════════════════════════════════════════════\n`);
  }
}
