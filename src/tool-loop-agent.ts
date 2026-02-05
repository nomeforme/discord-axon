/**
 * ToolLoopAgent - Agent with native tool execution loop
 *
 * This agent wraps around the LLM provider to implement proper tool calling:
 * 1. Call LLM with tools
 * 2. If stop_reason is 'tool_use', execute tools and send results back
 * 3. Loop until stop_reason is 'end_turn' or max rounds reached
 *
 * This fixes the hallucination issue where bots would pretend they got
 * tool results without actually waiting for them.
 */

import { BasicAgent, VEILStateManager } from 'connectome-ts';
import type { AgentConfig } from 'connectome-ts/dist/agent/types.js';
import type { Frame, StreamRef, VEILState, Facet, OutgoingVEILOperation, createDefaultTransition } from 'connectome-ts/dist/veil/types.js';
import type { RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';
import { AnthropicToolProvider, ToolSchema, ToolLLMResponse, ToolLLMOptions } from './anthropic-tool-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import axios from 'axios';

// Union type for providers that support tools
type ToolProvider = AnthropicToolProvider | BedrockProvider;

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, any>;
  /** Optional list of required parameter names (if not set, all are assumed required) */
  required?: string[];
  handler: (input: Record<string, any>) => Promise<string>;
}

export interface ToolLoopAgentConfig {
  name: string;
  systemPrompt?: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  maxToolRounds?: number;
  tools?: ToolHandler[];
}

export class ToolLoopAgent {
  private config: ToolLoopAgentConfig;
  private provider: ToolProvider;
  private veilStateManager: VEILStateManager;
  private tools: Map<string, ToolHandler> = new Map();
  private maxToolRounds: number;

  constructor(
    config: ToolLoopAgentConfig,
    provider: ToolProvider,
    veilStateManager: VEILStateManager
  ) {
    this.config = config;
    this.provider = provider;
    this.veilStateManager = veilStateManager;
    this.maxToolRounds = config.maxToolRounds ?? 5;

    // Register tools
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  /**
   * Register a tool that the agent can use
   */
  registerTool(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get tool schemas for the API
   */
  private getToolSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.parameters,
        // Use explicit required array if provided, otherwise default to all parameters
        required: tool.required ?? Object.keys(tool.parameters)
      }
    }));
  }

  /**
   * Execute a tool by name
   */
  private async executeTool(name: string, input: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }

    try {
      console.log(`[ToolLoopAgent] Executing tool: ${name}`, input);
      const result = await tool.handler(input);
      console.log(`[ToolLoopAgent] Tool result length: ${result.length}`);
      return result;
    } catch (error: any) {
      console.error(`[ToolLoopAgent] Tool error:`, error);
      return `Error executing tool "${name}": ${error.message}`;
    }
  }

  /**
   * Run the agent cycle with tool loop
   */
  async runCycle(context: RenderedContext, streamRef?: StreamRef): Promise<{
    content: string;
    operations: OutgoingVEILOperation[];
    tokensUsed: number;
  }> {
    const toolSchemas = this.getToolSchemas();
    const hasTools = toolSchemas.length > 0;

    console.log(`[ToolLoopAgent] Starting cycle with ${toolSchemas.length} tools`);
    console.log(`[ToolLoopAgent] Context keys: ${Object.keys(context).join(', ')}`);
    console.log(`[ToolLoopAgent] Messages count: ${context.messages.length}`);

    // Log message history before sending to LLM (last 10 messages only)
    console.log(`[ToolLoopAgent] === MESSAGE HISTORY (${context.messages.length} total, showing last 10) ===`);
    const historyStartIndex = Math.max(0, context.messages.length - 10);
    if (historyStartIndex > 0) {
      console.log(`[ToolLoopAgent] ... (${historyStartIndex} earlier messages omitted)`);
    }
    for (let i = historyStartIndex; i < context.messages.length; i++) {
      const msg = context.messages[i];
      const contentPreview = String(msg.content).substring(0, 300).replace(/\n/g, '\\n');
      console.log(`[ToolLoopAgent] [${i}] ${msg.role}: ${contentPreview}${msg.content.length > 300 ? '...' : ''}`);
    }
    console.log(`[ToolLoopAgent] === END MESSAGE HISTORY ===`);

    // When using tools, we can't have an assistant prefill message at the end
    // The HUD may add one for <my_turn> formatting - strip ALL trailing assistant messages
    let messages = [...context.messages];
    if (hasTools) {
      let removedCount = 0;
      while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        const lastMsg = messages[messages.length - 1];
        console.log(`[ToolLoopAgent] Removing trailing assistant message for tool compatibility: "${lastMsg.content.substring(0, 30)}..."`);
        messages = messages.slice(0, -1);
        removedCount++;
      }
      if (removedCount > 0) {
        console.log(`[ToolLoopAgent] Removed ${removedCount} trailing assistant message(s)`);
      }
      if (messages.length > 0) {
        console.log(`[ToolLoopAgent] Final last message role: ${messages[messages.length - 1].role}`);
      }
    }

    const options: ToolLLMOptions = {
      maxTokens: this.config.defaultMaxTokens || 4096,
      temperature: this.config.defaultTemperature || 1.0,
      tools: hasTools ? toolSchemas : undefined
    };

    // DEBUG: Log full context being sent to LLM (redact base64 image data)
    console.log(`\n[ToolLoopAgent] ========== FULL LLM REQUEST ==========`);
    const redactedMessages = messages.map(msg => {
      if (msg.metadata?.attachments) {
        return {
          ...msg,
          metadata: {
            ...msg.metadata,
            attachments: msg.metadata.attachments.map((att: any) => ({
              ...att,
              data: att.data ? `[BASE64 IMAGE: ${Math.round(att.data.length / 1024)}KB]` : undefined
            }))
          }
        };
      }
      return msg;
    });
    console.log(JSON.stringify(redactedMessages, null, 2));
    console.log(`[ToolLoopAgent] ========== END LLM REQUEST ==========\n`);

    // Initial LLM call
    let response = await this.provider.generate(messages, options);
    let totalTokens = response.tokensUsed || 0;
    let toolRounds = 0;
    let allContent = response.content;

    // Tool execution loop
    while (response.stopReason === 'tool_use' && response.toolCalls && toolRounds < this.maxToolRounds) {
      toolRounds++;
      console.log(`[ToolLoopAgent] Tool round ${toolRounds}/${this.maxToolRounds}`);

      // Execute all tool calls
      const toolResults: Array<{ tool_use_id: string; content: string }> = [];

      for (const toolCall of response.toolCalls) {
        const result = await this.executeTool(toolCall.name, toolCall.input);
        toolResults.push({
          tool_use_id: toolCall.id,
          content: result
        });
      }

      // Get the raw content blocks for continuation
      const assistantContent = this.getAssistantContent(response);

      // Send tool results back
      response = await this.provider.sendToolResults(
        context.messages,
        assistantContent,
        toolResults,
        options
      );

      totalTokens += response.tokensUsed || 0;

      // Accumulate content (the final response after tools)
      if (response.content) {
        allContent = response.content; // Use final response, not accumulated
      }
    }

    if (toolRounds >= this.maxToolRounds && response.stopReason === 'tool_use') {
      console.warn(`[ToolLoopAgent] Max tool rounds (${this.maxToolRounds}) reached`);
      allContent += '\n\n(Tool execution limit reached)';
    }

    console.log(`[ToolLoopAgent] Cycle complete. Tool rounds: ${toolRounds}, content length: ${allContent.length}`);
    console.log(`[ToolLoopAgent] Raw content from LLM:\n---\n${allContent}\n---`);

    // Create speech facet from the response
    const operations: OutgoingVEILOperation[] = [];

    if (allContent.trim()) {
      console.log(`[ToolLoopAgent] Creating speech facet with content: ${allContent.trim().substring(0, 200)}...`);
      operations.push({
        type: 'addFacet',
        facet: {
          id: `speech-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'speech',
          content: allContent.trim(),
          agentId: this.config.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          agentName: this.config.name,
          streamId: streamRef?.streamId || 'default'
        } as Facet
      });
    }

    return {
      content: allContent,
      operations,
      tokensUsed: totalTokens
    };
  }

  /**
   * Get assistant content blocks for tool result continuation
   */
  private getAssistantContent(response: ToolLLMResponse): any[] {
    // Build content blocks from response
    const blocks: any[] = [];

    // Add text if present
    if (response.content) {
      blocks.push({ type: 'text', text: response.content });
    }

    // Add tool use blocks
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input
        });
      }
    }

    return blocks;
  }

  /**
   * Get agent name
   */
  getName(): string {
    return this.config.name;
  }
}

/**
 * Create a fetch tool handler
 */
export function createFetchTool(): ToolHandler {
  return {
    name: 'fetch',
    description: 'Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.',
    parameters: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must be a valid HTTP/HTTPS URL)'
      }
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const url = input.url;
      if (!url) {
        return 'Error: No URL provided';
      }

      try {
        const response = await axios.get(url, {
          timeout: 30000,
          maxRedirects: 5,
          maxBodyLength: 100000,
          validateStatus: (status: number) => status < 500,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SignalBot/1.0)'
          }
        });

        // Limit response size
        const content = String(response.data).substring(0, 50000);
        return `Successfully fetched content from ${url}:\n\n${content}`;
      } catch (error: any) {
        return `Error fetching ${url}: ${error.message}`;
      }
    }
  };
}
