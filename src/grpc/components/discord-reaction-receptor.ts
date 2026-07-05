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

/**
 * Module-level dedupe cache — shared across all `DiscordReactionReceptor`
 * instances (one per managed bot). When N bots share a guild, discord.js
 * fires `messageReactionAdd`/`Remove` on every bot's client for the same
 * physical reaction; without this, one user click fans out to N gRPC emits
 * and N idempotent-skip round trips in the server's event handler.
 *
 * Mirrors the pattern in `signal-axon/src/message-deduplicator.ts`. Keyed
 * on the reaction identity (message + user + emoji + direction); scoped to
 * a short window because Discord may re-deliver the same event within a
 * few seconds under gateway reconnects.
 */
interface SeenReaction { firstReceiver: string; timestamp: number; }
const seenReactions = new Map<string, SeenReaction>();
const REACTION_DEDUPE_TTL_MS = 10_000;
let lastReactionCleanup = 0;

function shouldEmitReaction(dedupeKey: string, botName: string): boolean {
  const now = Date.now();
  if (now - lastReactionCleanup > 5_000) {
    lastReactionCleanup = now;
    const expiry = now - REACTION_DEDUPE_TTL_MS;
    for (const [k, v] of seenReactions) {
      if (v.timestamp < expiry) seenReactions.delete(k);
    }
  }
  if (seenReactions.has(dedupeKey)) return false;
  seenReactions.set(dedupeKey, { firstReceiver: botName, timestamp: now });
  return true;
}

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

    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? '';

    // Cross-bot dedupe — every managed bot in the guild sees the same reaction
    // via its own discord.js gateway client, but only one should forward it to
    // the connectome server (the handler is idempotent, but N× traffic + logs
    // are still avoidable). DMs are per-bot so they don't need this, but the
    // key is unique enough (includes messageId) that even DM double-fire on
    // reconnect gets suppressed harmlessly.
    const dedupeKey = `${reaction.message.id}-${user.id}-${emoji}-${added ? 'a' : 'r'}`;
    if (!shouldEmitReaction(dedupeKey, botName)) {
      return;
    }

    try {
      await this.bot.grpcClient.emitDiscordReaction({
        emoji,
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
