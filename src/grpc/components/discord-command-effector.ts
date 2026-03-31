/**
 * DiscordCommandEffector - gRPC equivalent of the non-gRPC DiscordCommandEffector
 *
 * Handles !-prefixed commands:
 * - !rr - Random reply chance
 * - !bb - Bot-to-bot mention limit
 * - !mcf - Max conversation frames
 * - !mmf - Max memory frames
 * - !stop - Abort the current agent cycle
 * - !steer <message> - Redirect the running agent mid-cycle
 * - !autotrigger - Enable/disable autonomous self-triggering loop
 * - !help - Show available commands
 *
 * This is the gRPC client-side equivalent - it processes commands
 * and returns responses to be sent via Discord.
 */

import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import type { RuntimeConfig } from '../types.js';

const SECRETS_DIR = '/workspace/shared/secrets';

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
    emitEvent?: EmitEventCallback,
    attachments?: any[]
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

      case '!stop':
        return this.handleStop(emitEvent);

      case '!steer':
        return this.handleSteer(args, emitEvent, attachments);

      case '!autotrigger':
        return this.handleAutoTrigger(args, emitEvent);

      case '!stream':
        return this.handleStream(args, emitEvent);

      case '!secret':
        return this.handleSecret(args);

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

\`!continue\` - Continue from the bot's last message (prefill)
  - Also: \`m continue\`, \`m go\`, \`m more\`
\`!stop\` - Abort the current agent cycle
\`!steer <message>\` - Redirect the running agent mid-cycle

\`!stream in <name>\` - Enter a named substream
  - Bot activations redirect to the substream (full history)
  - \`!stream out <name>\` = exit substream, return to parent channel
  - \`!stream\` = show usage

\`!autotrigger [on|off]\` - Autonomous self-triggering loop
  - \`on\` or no argument = enable
  - \`off\` = disable
  - Bot must call \`continue_substream\` tool to get another cycle (no call = loop ends)
  - \`--stream <name>\` = shorthand: enter stream + enable autotrigger
  - \`--max-speech-only <N>\` = safety net: eject after N idle cycles (default: 5)

\`!secret <name> <value>\` - Store a secret (never reaches VEIL)
  - \`!secret HF_TOKEN hf_abc123\` = store
  - \`!secret list\` = list names (not values)
  - \`!secret delete <name>\` = remove
  - Bots use \`inject_secret\` tool to pipe to remote .env files

\`!help\` - Show this message`;
  }

  /**
   * Handle !secret command — write to shared secrets dir, never touches VEIL
   */
  private handleSecret(args: string): string | null {
    try {
      mkdirSync(SECRETS_DIR, { recursive: true });
    } catch { /* already exists */ }

    if (!args || args === 'list') {
      try {
        const files = readdirSync(SECRETS_DIR);
        if (files.length === 0) return 'No secrets stored.';
        return `**Stored secrets:** ${files.join(', ')}`;
      } catch {
        return 'No secrets stored.';
      }
    }

    if (args.startsWith('delete ')) {
      const name = args.slice(7).trim();
      if (!name) return 'Usage: `!secret delete <name>`';
      try {
        unlinkSync(join(SECRETS_DIR, name));
        return `Deleted secret: ${name}`;
      } catch {
        return `Secret not found: ${name}`;
      }
    }

    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1) return 'Usage: `!secret <name> <value>`';

    const name = args.slice(0, spaceIdx).trim();
    const value = args.slice(spaceIdx + 1).trim();

    if (!name || !value) return 'Usage: `!secret <name> <value>`';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return 'Secret name must be alphanumeric/underscore.';

    try {
      writeFileSync(join(SECRETS_DIR, name), value, { mode: 0o600 });
      return `Secret stored: **${name}** (${value.length} chars)`;
    } catch (err: any) {
      return `Error storing secret: ${err.message}`;
    }
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
   * Handle !stop — abort the current agent cycle
   */
  private handleStop(emitEvent?: EmitEventCallback): string {
    if (emitEvent) {
      emitEvent('agent:command', {
        type: 'stop',
        targetAgent: this.botName,
      }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit stop:`, e.message));
    }
    return `Stopping ${this.botName}...`;
  }

  /**
   * Handle !steer <message> — redirect the running agent mid-cycle
   */
  private handleSteer(args: string, emitEvent?: EmitEventCallback, attachments?: any[]): string {
    if (!args && !attachments?.length) return 'Usage: `!steer <message>`';
    if (emitEvent) {
      emitEvent('agent:command', {
        type: 'steer',
        message: args || '(file attached)',
        targetAgent: this.botName,
        ...(attachments?.length ? { attachments } : {}),
      }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit steer:`, e.message));
    }
    return `Steering ${this.botName}: ${args || '(file attached)'}`;
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

  /**
   * Handle !autotrigger — enable/disable autonomous self-triggering loop
   *
   * Usage:
   *   !autotrigger              → enable autotrigger
   *   !autotrigger on           → enable autotrigger
   *   !autotrigger off          → disable autotrigger
   *   !autotrigger --stream X  → shorthand: enter substream + enable autotrigger
   */
  private handleAutoTrigger(args: string, emitEvent?: EmitEventCallback): string {
    const parts = args.split(/\s+/).filter(Boolean);
    let enable = true;
    let substreamName: string | undefined;
    let maxSpeechOnly: number | undefined;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].toLowerCase();
      if (part === 'off') {
        enable = false;
      } else if (part === 'on') {
        enable = true;
      } else if (part === '--stream' && i + 1 < parts.length) {
        substreamName = parts[i + 1];
        i++;
      } else if (part === '--max-speech-only' && i + 1 < parts.length) {
        const val = parseInt(parts[i + 1], 10);
        if (!isNaN(val) && val > 0) maxSpeechOnly = val;
        i++;
      }
    }

    if (emitEvent) {
      // If --stream was specified and enabling, emit substream command FIRST
      if (substreamName && enable) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: true,
          workflowName: substreamName,
        }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit substream:`, e.message));
      }

      // Emit autotrigger command (substream handled separately above)
      emitEvent('agent:command', {
        type: 'autotrigger',
        targetAgent: this.botName,
        enable,
        maxSpeechOnly,
      }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit autotrigger:`, e.message));
    }

    if (!enable) {
      return `Autotrigger disabled for ${this.botName}`;
    }
    const ssMsg = substreamName ? ` (substream: ${substreamName})` : '';
    const msoMsg = maxSpeechOnly ? `, max-speech-only: ${maxSpeechOnly}` : '';
    return `Autotrigger enabled for ${this.botName}${ssMsg}${msoMsg} — use \`!stop\` to halt`;
  }

  /**
   * Handle !stream — enter/exit a named substream
   *
   * Usage:
   *   !stream in <name>   → enter substream
   *   !stream out <name>  → exit substream
   *   !stream             → show usage
   */
  private handleStream(args: string, emitEvent?: EmitEventCallback): string {
    const parts = args.split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      return `Usage: \`!stream in <name>\` to enter, \`!stream out <name>\` to exit.`;
    }

    const direction = parts[0].toLowerCase();

    if (direction === 'out') {
      if (emitEvent) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: false,
        }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit stream out:`, e.message));
      }
      return `Substream exited for ${this.botName}`;
    }

    if (direction === 'in' && parts.length >= 2) {
      const substreamName = parts[1];
      if (emitEvent) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: true,
          workflowName: substreamName,
        }).catch((e: any) => console.error(`[DiscordCommandEffector:${this.botName}] Failed to emit stream in:`, e.message));
      }
      return `Substream "${substreamName}" entered for ${this.botName}`;
    }

    return `Usage: \`!stream in <name>\` to enter, \`!stream out <name>\` to exit.`;
  }
}
