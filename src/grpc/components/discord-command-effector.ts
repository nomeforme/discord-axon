/**
 * DiscordCommandEffector - gRPC equivalent of the non-gRPC DiscordCommandEffector
 *
 * Handles !-prefixed commands:
 * - !rr - Random reply chance
 * - !bb - Bot-to-bot mention limit
 * - !mcf - Max conversation frames
 * - !mmf - Max memory frames
 * - !help - Show available commands
 *
 * This is the gRPC client-side equivalent - it processes commands
 * and returns responses to be sent via Discord.
 */

import type { RuntimeConfig } from '../types.js';

/**
 * Callback type for updating config values
 */
export type ConfigUpdateCallback = (updates: Partial<RuntimeConfig>) => void;

/**
 * DiscordCommandEffector - Handles !-prefixed commands
 *
 * Constraint equivalent: EFFECTOR priority (processes command facets)
 */
export type EmitEventCallback = (topic: string, payload: Record<string, any>) => Promise<any>;

export class DiscordCommandEffector {
  private botName: string;
  /** Tracks the last-set maxOutputTokens override (axon-local, per command effector instance) */
  private maxOutputTokensOverride: number | undefined;

  constructor(botName: string) {
    this.botName = botName;
  }

  /**
   * Handle a command message
   *
   * @param message - The full message content
   * @param currentConfig - Current runtime configuration
   * @param updateConfig - Callback to update configuration
   * @param emitEvent - Optional callback to emit events to Connectome (for per-bot config commands)
   * @returns Response message, or null if not a command
   */
  handleCommand(
    message: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback,
    emitEvent?: EmitEventCallback
  ): string | null {
    // Strip leading mentions
    let cleaned = message.trim();
    cleaned = cleaned.replace(/^(<@[!&]?\d+>\s*)+/g, '').trim();

    if (!cleaned.startsWith('!')) return null;

    const parts = cleaned.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    console.log(`[DiscordCommandEffector:${this.botName}] Handling command: ${command} args="${args}"`);

    switch (command) {
      case '!help':
        return this.handleHelp();

      case '!rr':
        return this.handleRandomReply(args, currentConfig, updateConfig);

      case '!bb':
        return this.handleBotToBotLimit(args, currentConfig, updateConfig);

      case '!mcf':
        return this.handleMaxConversationFrames(args, currentConfig, updateConfig);

      case '!mmf':
        return this.handleMaxMemoryFrames(args, currentConfig, updateConfig);

      case '!mt':
        return this.handleMaxTokens(args, emitEvent);

      default:
        return null; // Not a recognized command
    }
  }

  /**
   * Handle !help command
   */
  private handleHelp(): string {
    return `**Available Commands**

\`!rr [number]\` - Random reply chance
  - 0 = disabled
  - 1 = 100% (reply to every message)
  - 10 = 10%, 100 = 1%, etc.
  - No argument shows current setting

\`!bb [number]\` - Bot-to-bot mention limit
  - Max mentions before requiring human message
  - 0 = disabled, 1+ = limit
  - No argument shows current setting

\`!mcf [number]\` - Max context frames
  - Rolling window for context
  - No argument shows current setting

\`!mmf [number]\` - Max memory frames
  - Frames kept in RAM (rest on disk)
  - No argument shows current setting

\`!mt [number]\` - Max output tokens (per-bot)
  - Max tokens the bot generates per response
  - 0 = reset to model default
  - Mention a specific bot to target it
  - No argument shows current setting

\`!help\` - Show this message`;
  }

  /**
   * Handle !rr (random reply) command
   */
  private handleRandomReply(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      // Show current setting
      const chance = currentConfig.randomReplyChance;
      if (chance === 0) {
        return 'Random reply is currently disabled (0)';
      } else {
        const percentage = (100 / chance).toFixed(1);
        return `Random reply: 1/${chance} (${percentage}%)`;
      }
    }

    const newChance = parseInt(args);
    if (isNaN(newChance) || newChance < 0) {
      return 'Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)';
    }

    updateConfig({ randomReplyChance: newChance });

    if (newChance === 0) {
      return 'Random reply disabled';
    } else if (newChance === 1) {
      return 'Random reply set to 1/1 (100%) - bots will reply to every message';
    } else {
      const percentage = (100 / newChance).toFixed(1);
      return `Random reply set to 1/${newChance} (${percentage}%)`;
    }
  }

  /**
   * Handle !bb (bot-to-bot limit) command
   */
  private handleBotToBotLimit(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      // Show current setting
      const limit = currentConfig.maxBotMentionsPerConversation;
      if (limit === 0) {
        return 'Bot-to-bot mentions are currently disabled (0)';
      } else {
        return `Bot-to-bot mention limit: ${limit}`;
      }
    }

    const newLimit = parseInt(args);
    if (isNaN(newLimit) || newLimit < 0) {
      return 'Invalid value. Use a number >= 0 (0 = disabled)';
    }

    updateConfig({ maxBotMentionsPerConversation: newLimit });

    if (newLimit === 0) {
      return 'Bot-to-bot mentions disabled';
    } else {
      return `Bot-to-bot mention limit set to ${newLimit}`;
    }
  }

  /**
   * Handle !mcf (max conversation frames) command
   */
  private handleMaxConversationFrames(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      // Show current setting
      const maxFrames = currentConfig.maxConversationFrames;
      return `Max conversation frames: ${maxFrames}`;
    }

    const newMaxFrames = parseInt(args);
    if (isNaN(newMaxFrames) || newMaxFrames < 10) {
      return 'Invalid value. Use a number >= 10';
    }

    updateConfig({ maxConversationFrames: newMaxFrames });
    return `Max conversation frames set to ${newMaxFrames}`;
  }

  /**
   * Handle !mmf (max memory frames) command
   */
  private handleMaxMemoryFrames(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      // Show current setting
      const maxMemFrames = currentConfig.maxMemoryFrames;
      return `Max memory frames: ${maxMemFrames}`;
    }

    const newMaxMemFrames = parseInt(args);
    if (isNaN(newMaxMemFrames) || newMaxMemFrames < 10) {
      return 'Invalid value. Use a number >= 10';
    }

    updateConfig({ maxMemoryFrames: newMaxMemFrames });
    return `Max memory frames set to ${newMaxMemFrames}`;
  }

  /**
   * Handle !mt (max output tokens) command — per-bot, routed via Connectome
   */
  private handleMaxTokens(
    args: string,
    emitEvent?: EmitEventCallback
  ): string {
    if (!args) {
      // Show current override
      if (this.maxOutputTokensOverride === undefined) {
        return `Max output tokens for ${this.botName}: using model default`;
      }
      return `Max output tokens for ${this.botName}: ${this.maxOutputTokensOverride}`;
    }

    const newMaxTokens = parseInt(args);
    if (isNaN(newMaxTokens) || newMaxTokens < 0) {
      return 'Invalid value. Use a number >= 0 (0 = reset to model default)';
    }

    // 0 means reset to model default
    const value = newMaxTokens === 0 ? undefined : newMaxTokens;
    this.maxOutputTokensOverride = value;

    // Emit config event to Connectome so bot-runtime picks it up
    if (emitEvent) {
      emitEvent('bot:config', {
        targetAgent: this.botName,
        maxOutputTokens: value ?? null,  // null signals "reset to default"
      }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit config event:`, e.message));
    }

    if (value === undefined) {
      return `Max output tokens for ${this.botName} reset to model default`;
    }
    return `Max output tokens for ${this.botName} set to ${value}`;
  }
}
