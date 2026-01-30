/**
 * Command handling for Discord AXON
 * Handles ! commands locally
 */

import type { RuntimeConfig } from './types.js';

/**
 * Handle ! commands locally
 * Returns response message if command was handled, undefined otherwise
 */
export function handleCommand(
  content: string,
  config: RuntimeConfig,
  updateConfig: (updates: Partial<RuntimeConfig>) => void
): string | undefined {
  // Strip leading mentions (format: <@username> or <@!userid>)
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^(<@[!&]?\d+>\s*)+/g, '').trim();

  if (!cleaned.startsWith('!')) return undefined;
  const trimmed = cleaned;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch (command) {
    case '!help':
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

\`!help\` - Show this message`;

    case '!rr': {
      if (!args) {
        const chance = config.randomReplyChance;
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

    case '!bb': {
      if (!args) {
        const limit = config.maxBotMentionsPerConversation;
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

    case '!mcf': {
      if (!args) {
        return `Max context frames: ${config.maxConversationFrames}`;
      }
      const newMaxFrames = parseInt(args);
      if (isNaN(newMaxFrames) || newMaxFrames < 10) {
        return 'Invalid value. Use a number >= 10';
      }
      updateConfig({ maxConversationFrames: newMaxFrames });
      return `Max context frames set to ${newMaxFrames}`;
    }

    case '!mmf': {
      if (!args) {
        return `Max memory frames: ${config.maxMemoryFrames}`;
      }
      const newMaxMemFrames = parseInt(args);
      if (isNaN(newMaxMemFrames) || newMaxMemFrames < 10) {
        return 'Invalid value. Use a number >= 10';
      }
      updateConfig({ maxMemoryFrames: newMaxMemFrames });
      return `Max memory frames set to ${newMaxMemFrames}`;
    }

    default:
      if (trimmed.startsWith('!')) {
        return `Unknown command: ${command}. Use !help for available commands.`;
      }
      return undefined;
  }
}
