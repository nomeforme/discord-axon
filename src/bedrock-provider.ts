/**
 * AWS Bedrock LLM Provider with Native Tool Support
 *
 * Implements the LLMProvider interface for AWS Bedrock's Claude models.
 * Supports native tool calling via the Bedrock converse API.
 */

import AWS from 'aws-sdk';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse
} from 'connectome-ts/dist/llm/llm-interface.js';
import type { ToolSchema, ToolLLMOptions, ToolLLMResponse } from './anthropic-tool-provider.js';

export interface BedrockProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class BedrockProvider implements LLMProvider {
  private client: AWS.BedrockRuntime;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: BedrockProviderConfig) {
    this.client = new AWS.BedrockRuntime({
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
    });
    this.defaultModel = config.defaultModel || 'claude-3-5-sonnet-20241022';
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  /**
   * Convert model name to Bedrock model ID
   * e.g., claude-3-5-sonnet-20241022 -> us.anthropic.claude-3-5-sonnet-20241022-v2:0
   */
  private getBedrockModelId(modelName: string): string {
    // Remove 'bedrock-' prefix if present
    const baseModel = modelName.replace(/^bedrock-/, '');

    // Special case for claude-3-5-sonnet-20241022 (uses v2 and us. prefix)
    if (baseModel.includes('claude-3-5-sonnet-20241022')) {
      return `us.anthropic.${baseModel}-v2:0`;
    }

    // Models requiring us. prefix for inference profiles
    if (baseModel.includes('claude-3-opus')) {
      return `us.anthropic.${baseModel}-v1:0`;
    }

    // Standard format for other models
    return `anthropic.${baseModel}-v1:0`;
  }

  async generate(messages: LLMMessage[], options?: ToolLLMOptions): Promise<ToolLLMResponse> {
    // Filter out cache markers and system messages
    const apiMessages = messages.filter(m => m.role !== 'cache');

    // Extract system message
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build stop sequences
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Convert to Bedrock format and merge consecutive user messages
    const bedrockMessages = this.mergeConsecutiveMessages(
      conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: this.formatContent(msg)
      }))
    );

    const modelId = options?.modelId || this.defaultModel;
    const bedrockModelId = this.getBedrockModelId(modelId);

    const bedrockBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: bedrockMessages
    };

    if (systemMessage) {
      bedrockBody.system = systemMessage;
    }

    if (stopSequences.length > 0) {
      bedrockBody.stop_sequences = stopSequences;
    }

    if (options?.temperature !== undefined) {
      bedrockBody.temperature = options.temperature;
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      bedrockBody.tools = options.tools;
    }

    console.log('[BedrockProvider:generate] Starting request...');
    console.log('[BedrockProvider:generate] Model ID:', bedrockModelId);
    console.log('[BedrockProvider:generate] Message count:', bedrockMessages.length);
    console.log('[BedrockProvider:generate] Tools:', options?.tools?.map(t => t.name).join(', ') || 'none');

    // Retry logic
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[BedrockProvider] Retry attempt ${attempt}/${this.maxRetries}`);
        }

        const params = {
          modelId: bedrockModelId,
          body: JSON.stringify(bedrockBody),
          contentType: 'application/json',
          accept: 'application/json'
        };

        const response = await this.client.invokeModel(params).promise();
        const responseBody = JSON.parse(response.body?.toString() || '{}');

        // Store raw content blocks for tool result continuation
        this._lastResponseContent = responseBody.content;

        // Extract text content
        const textContent = responseBody.content
          ?.filter((block: any) => block.type === 'text')
          ?.map((block: any) => block.text)
          ?.join('') || '';

        // Extract tool use blocks
        const toolCalls = responseBody.content
          ?.filter((block: any) => block.type === 'tool_use')
          ?.map((block: any) => ({
            id: block.id,
            name: block.name,
            input: block.input
          })) || [];

        console.log('[BedrockProvider:generate] Response length:', textContent.length);
        console.log('[BedrockProvider:generate] Stop reason:', responseBody.stop_reason);
        console.log('[BedrockProvider:generate] Tool calls:', toolCalls.length);

        return {
          content: textContent,
          tokensUsed: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
          modelId: bedrockModelId,
          stopReason: responseBody.stop_reason as ToolLLMResponse['stopReason'],
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
      } catch (error: any) {
        lastError = error;
        console.error(`[BedrockProvider] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`,
          error.message);

        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);

        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          console.log(`[BedrockProvider] Will retry in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        break;
      }
    }

    throw new Error(`Bedrock API error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Send tool results back to the API and get the next response
   */
  async sendToolResults(
    messages: LLMMessage[],
    assistantContent: any[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    options?: ToolLLMOptions
  ): Promise<ToolLLMResponse> {
    const apiMessages = messages.filter(m => m.role !== 'cache');
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build base messages
    const bedrockMessages = this.mergeConsecutiveMessages(
      conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: this.formatContent(msg)
      }))
    );

    // Add the assistant message with tool use
    bedrockMessages.push({
      role: 'assistant',
      content: assistantContent
    });

    // Add tool results as user message
    bedrockMessages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result',
        tool_use_id: tr.tool_use_id,
        content: tr.content
      }))
    });

    const modelId = options?.modelId || this.defaultModel;
    const bedrockModelId = this.getBedrockModelId(modelId);

    const bedrockBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: bedrockMessages
    };

    if (systemMessage) {
      bedrockBody.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      bedrockBody.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      bedrockBody.tools = options.tools;
    }

    console.log('[BedrockProvider:sendToolResults] Sending tool results...');
    console.log('[BedrockProvider:sendToolResults] Tool results count:', toolResults.length);

    const params = {
      modelId: bedrockModelId,
      body: JSON.stringify(bedrockBody),
      contentType: 'application/json',
      accept: 'application/json'
    };

    const response = await this.client.invokeModel(params).promise();
    const responseBody = JSON.parse(response.body?.toString() || '{}');

    this._lastResponseContent = responseBody.content;

    const textContent = responseBody.content
      ?.filter((block: any) => block.type === 'text')
      ?.map((block: any) => block.text)
      ?.join('') || '';

    const toolCalls = responseBody.content
      ?.filter((block: any) => block.type === 'tool_use')
      ?.map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input
      })) || [];

    console.log('[BedrockProvider:sendToolResults] Stop reason:', responseBody.stop_reason);
    console.log('[BedrockProvider:sendToolResults] New tool calls:', toolCalls.length);

    return {
      content: textContent,
      tokensUsed: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
      modelId: bedrockModelId,
      stopReason: responseBody.stop_reason as ToolLLMResponse['stopReason'],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  /**
   * Get the raw content blocks from the last response for tool result continuation
   */
  getLastResponseContent(): any[] | undefined {
    return this._lastResponseContent;
  }

  private _lastResponseContent?: any[];

  /**
   * Format message content for Bedrock API
   */
  private formatContent(msg: LLMMessage): Array<{ type: string; text?: string; source?: any }> {
    // For assistant messages, trim trailing whitespace
    const content = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;

    const contentBlocks: Array<{ type: string; text?: string; source?: any }> = [];

    // Handle attachments if present
    const attachments = msg.metadata?.attachments;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const attachment of attachments) {
        const contentType = attachment.contentType || attachment.mimeType || '';
        const isImage = contentType.startsWith('image/');

        if (isImage && attachment.data) {
          const mediaType = this.getValidatedMediaType(attachment.data, contentType);
          if (mediaType) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: attachment.data
              }
            });
          } else {
            console.log(`[BedrockProvider] Skipping unsupported image format: ${contentType}`);
          }
        }
      }
    }

    // Add text content
    if (content) {
      contentBlocks.push({ type: 'text', text: content });
    }

    return contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }];
  }

  /**
   * Merge consecutive user messages and ensure proper message ordering (Bedrock requirement)
   * - First message must be user role (required by Claude 3 Sonnet)
   * - No consecutive messages of the same role
   */
  private mergeConsecutiveMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: any }>
  ): Array<{ role: 'user' | 'assistant'; content: any }> {
    if (!messages || messages.length === 0) return messages;

    const merged: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i];

      if (current.role === 'user') {
        const userContents: any[] = [];

        while (i < messages.length && messages[i].role === 'user') {
          const content = messages[i].content;
          if (Array.isArray(content)) {
            userContents.push(...content);
          } else if (typeof content === 'string') {
            userContents.push({ type: 'text', text: content });
          }
          i++;
        }

        merged.push({ role: 'user', content: userContents });
      } else {
        // Check for consecutive assistant messages
        if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
          // Insert separator user message
          merged.push({ role: 'user', content: [{ type: 'text', text: '[continue]' }] });
        }
        merged.push(current);
        i++;
      }
    }

    // Ensure first message is user role (required by Claude 3 Sonnet and some other models)
    if (merged.length > 0 && merged[0].role === 'assistant') {
      merged.unshift({ role: 'user', content: [{ type: 'text', text: '[conversation history]' }] });
    }

    return merged;
  }

  private getMediaType(contentType: string): string {
    const normalized = contentType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
    if (normalized.includes('png')) return 'image/png';
    if (normalized.includes('gif')) return 'image/gif';
    if (normalized.includes('webp')) return 'image/webp';
    return 'image/jpeg';
  }

  /**
   * Detect actual image format from base64 data using magic bytes
   */
  private detectImageTypeFromBase64(base64Data: string): string | null {
    try {
      const buffer = Buffer.from(base64Data.slice(0, 32), 'base64');

      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
      }

      // JPEG: FF D8 FF
      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
      }

      // GIF: 47 49 46 38 (GIF8)
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return 'image/gif';
      }

      // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
      if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
          buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
      }

      // HEIC/HEIF: Check for ftyp box
      if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        const brand = buffer.slice(8, 12).toString('ascii');
        if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'hevx'].includes(brand)) {
          console.log(`[BedrockProvider] Detected HEIC/HEIF image (brand: ${brand}) - not supported`);
          return null;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get validated media type, preferring detection from bytes
   */
  private getValidatedMediaType(base64Data: string, declaredContentType: string): string | null {
    const detectedType = this.detectImageTypeFromBase64(base64Data);
    if (detectedType) {
      const declaredType = this.getMediaType(declaredContentType);
      if (declaredType !== detectedType) {
        console.log(`[BedrockProvider] Image type mismatch: declared ${declaredContentType} but detected ${detectedType}`);
      }
      return detectedType;
    }
    return this.getMediaType(declaredContentType);
  }

  private isRetryableError(error: any): boolean {
    if (error.statusCode) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (retryableStatuses.includes(error.statusCode)) {
        return true;
      }
    }

    const message = (error.message || '').toLowerCase();
    if (message.includes('throttl') ||
        message.includes('timeout') ||
        message.includes('connection')) {
      return true;
    }

    return false;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'bedrock';
  }

  getCapabilities(): {
    supportsPrefill: boolean;
    supportsCaching: boolean;
    supportsStreaming: boolean;
    maxContextLength?: number;
    supportsTools?: boolean;
  } {
    return {
      supportsPrefill: true,
      supportsCaching: false,
      supportsStreaming: false, // ToolLoopAgent uses generate(), not generateStream()
      maxContextLength: 200000,
      supportsTools: true
    };
  }

  async *generateStream(
    messages: import('connectome-ts').LLMMessage[],
    options?: import('connectome-ts').LLMOptions
  ): AsyncIterable<import('connectome-ts').LLMStreamChunk> {
    // BedrockProvider uses generate() for tool support, not streaming
    throw new Error('BedrockProvider does not support streaming - use generate() instead');
  }
}
