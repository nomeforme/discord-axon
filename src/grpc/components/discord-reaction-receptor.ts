/**
 * DiscordReactionReceptor - Handles Discord reaction events
 *
 * Processes message reactions:
 * - Filters out reactions from our bots
 * - Emits reaction events to Connectome server
 *
 * This follows the receptor pattern for handling specific event types.
 */

import type { BotInstance, SharedState } from '../types.js';

export interface DiscordReactionReceptorConfig {
  bot: BotInstance;
  state: SharedState;
}

/**
 * DiscordReactionReceptor - Handles Discord reactions
 *
 * Constraint equivalent: RECEPTOR priority
 */
export class DiscordReactionReceptor {
  private bot: BotInstance;
  private state: SharedState;

  constructor(config: DiscordReactionReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
  }

  /**
   * Set up the Discord reaction event listener
   */
  setup(): void {
    const botName = this.bot.config.name;

    this.bot.discord.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, true);
    });

    // Removal — needed for state-based redaction semantics (any-🫥-present
    // hides the message; unhiding requires notification when the last user
    // unreacts).
    this.bot.discord.on('messageReactionRemove', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, false);
    });

    console.log(`[DiscordReactionReceptor:${botName}] Reaction handler registered (add + remove)`);
  }

  /**
   * Handle Discord reaction add/remove
   */
  private async handleReactionEvent(reaction: any, user: any, added: boolean): Promise<void> {
    const botName = this.bot.config.name;

    // Skip reactions from our bots
    if (this.state.botUserIdToName.has(user.id)) return;

    try {
      await this.bot.grpcClient.emitDiscordReaction({
        emoji: reaction.emoji.name ?? reaction.emoji.id ?? '',
        userId: user.id,
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        guildId: reaction.message.guildId ?? undefined,
        added,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error(`[DiscordReactionReceptor:${botName}] Error handling ${added ? 'add' : 'remove'}:`, error.message);
    }
  }
}
