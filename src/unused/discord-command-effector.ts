/**
 * DiscordCommandEffector - Handles !-prefixed commands
 *
 * Processes discord-command facets and sends responses via Discord.
 * Commands like !rr, !bb, !mcf, !mmf modify runtime configuration.
 *
 * Adapted from signal-axon's SignalCommandEffector.
 */

import { Component, priorityConstraint, ComponentPriority } from 'connectome-ts';
import type { ExecutionContext, ReadonlyVEILState, Facet } from 'connectome-ts';

/**
 * Callback type for updating config values
 */
export type ConfigUpdateCallback = (updates: {
  randomReplyChance?: number;
  maxBotMentionsPerConversation?: number;
  maxConversationFrames?: number;
  maxMemoryFrames?: number;
}) => void;

export interface DiscordCommandEffectorConfig {
  // Function to send messages back to Discord
  sendMessage: (channelId: string, content: string) => Promise<void>;
}

/**
 * DiscordCommandEffector handles command facets (!rr, !bb, !help)
 * and sends responses via Discord
 */
export class DiscordCommandEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  private config: DiscordCommandEffectorConfig;
  private onConfigUpdate?: ConfigUpdateCallback;

  constructor(config: DiscordCommandEffectorConfig, onConfigUpdate?: ConfigUpdateCallback) {
    super();
    this.config = config;
    this.onConfigUpdate = onConfigUpdate;
  }

  execute(context: ExecutionContext): void {
    const { state, frame } = context;
    if (!frame?.deltas) return;

    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'discord-command') {
        // Fire-and-forget async
        this.handleCommandAsync(delta.facet, state);
      }
    }
  }

  private handleCommandAsync(facet: Facet, state: ReadonlyVEILState): void {
    (async () => {
      try {
        await this.handleCommand(facet, state);
      } catch (error) {
        console.error('[DiscordCommandEffector] Error handling command:', error);
      }
    })();
  }

  private async handleCommand(facet: Facet, state: ReadonlyVEILState): Promise<void> {
    const facetState = (facet as any).state;
    const { command, args, channelId, currentConfig } = facetState;

    console.log(`[DiscordCommandEffector] Handling command: ${command} ${args}`);

    let response = '';
    let configUpdates: {
      randomReplyChance?: number;
      maxBotMentionsPerConversation?: number;
      maxConversationFrames?: number;
      maxMemoryFrames?: number;
    } | null = null;

    switch (command) {
      case '!help':
        response = `**Available Commands**

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

\`!help\` - Show this message`;
        break;

      case '!rr':
        if (!args) {
          // Show current setting
          const chance = currentConfig.randomReplyChance;
          if (chance === 0) {
            response = 'Random reply is currently disabled (0)';
          } else {
            const percentage = (100 / chance).toFixed(1);
            response = `Random reply: 1/${chance} (${percentage}%)`;
          }
        } else {
          const newChance = parseInt(args);
          if (isNaN(newChance) || newChance < 0) {
            response = 'Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)';
          } else {
            configUpdates = { randomReplyChance: newChance };
            if (newChance === 0) {
              response = 'Random reply disabled';
            } else if (newChance === 1) {
              response = 'Random reply set to 1/1 (100%) - bots will reply to every message';
            } else {
              const percentage = (100 / newChance).toFixed(1);
              response = `Random reply set to 1/${newChance} (${percentage}%)`;
            }
          }
        }
        break;

      case '!bb':
        if (!args) {
          // Show current setting
          const limit = currentConfig.maxBotMentionsPerConversation;
          if (limit === 0) {
            response = 'Bot-to-bot mentions are currently disabled (0)';
          } else {
            response = `Bot-to-bot mention limit: ${limit}`;
          }
        } else {
          const newLimit = parseInt(args);
          if (isNaN(newLimit) || newLimit < 0) {
            response = 'Invalid value. Use a number >= 0 (0 = disabled)';
          } else {
            configUpdates = { maxBotMentionsPerConversation: newLimit };
            if (newLimit === 0) {
              response = 'Bot-to-bot mentions disabled';
            } else {
              response = `Bot-to-bot mention limit set to ${newLimit}`;
            }
          }
        }
        break;

      case '!mcf':
        if (!args) {
          // Show current setting
          const maxFrames = currentConfig.maxConversationFrames;
          const totalFrames = currentConfig.currentFrameCount ?? 0;
          const displayFrames = Math.min(totalFrames, maxFrames);
          response = `Frames: ${displayFrames} / ${maxFrames}`;
        } else {
          const newMaxFrames = parseInt(args);
          if (isNaN(newMaxFrames) || newMaxFrames < 10) {
            response = 'Invalid value. Use a number >= 10';
          } else {
            configUpdates = { maxConversationFrames: newMaxFrames };
            response = `Max frames set to ${newMaxFrames}`;
          }
        }
        break;

      case '!mmf':
        if (!args) {
          // Show current setting
          const maxMemFrames = currentConfig.maxMemoryFrames;
          const totalFrames = currentConfig.currentFrameCount ?? 0;
          const displayFrames = Math.min(totalFrames, maxMemFrames);
          response = `Memory frames: ${displayFrames} / ${maxMemFrames}`;
        } else {
          const newMaxMemFrames = parseInt(args);
          if (isNaN(newMaxMemFrames) || newMaxMemFrames < 10) {
            response = 'Invalid value. Use a number >= 10';
          } else {
            configUpdates = { maxMemoryFrames: newMaxMemFrames };
            response = `Max memory frames set to ${newMaxMemFrames}`;
          }
        }
        break;

      default:
        response = `Unknown command: ${command}. Use !help for available commands.`;
    }

    // Update config if needed
    if (configUpdates && this.onConfigUpdate) {
      this.onConfigUpdate(configUpdates);
    }

    // Send response to Discord
    await this.sendResponse(response, channelId);
  }

  private async sendResponse(message: string, channelId: string): Promise<void> {
    try {
      await this.config.sendMessage(channelId, message);
      console.log(`[DiscordCommandEffector] Response sent to channel ${channelId}`);
    } catch (error) {
      console.error(`[DiscordCommandEffector] Failed to send response:`, error);
    }
  }
}
