/**
 * DiscordReadyReceptor - Handles Discord ready event
 *
 * Bot name and userId are already discovered during the login phase.
 * This receptor handles post-ready setup:
 * - Registers bot mapping on Connectome server
 * - Caches bot name variations for mention resolution
 */

import { getUserNameCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState } from '../types.js';

export interface DiscordReadyReceptorConfig {
  bot: BotInstance;
  state: SharedState;
}

/**
 * DiscordReadyReceptor - Handles Discord ready event
 *
 * Constraint equivalent: RECEPTOR priority
 */
export class DiscordReadyReceptor {
  private bot: BotInstance;
  private state: SharedState;
  private userNameCache: Map<string, string>;

  constructor(config: DiscordReadyReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.userNameCache = getUserNameCache();
  }

  /**
   * Set up the Discord ready event listener
   */
  setup(): void {
    const botName = this.bot.config.name;

    this.bot.discord.on('ready', async () => {
      await this.handleReady();
    });

    console.log(`[DiscordReadyReceptor:${botName}] Ready handler registered`);
  }

  /**
   * Handle Discord ready event
   *
   * Bot identity (name, userId) was already discovered during login phase.
   * This registers the mapping on the server and caches name variations.
   */
  private async handleReady(): Promise<void> {
    const botName = this.bot.config.name;

    console.log(`[DiscordReadyReceptor:${botName}] Logged in as ${this.bot.discord.user?.tag}`);

    if (this.bot.userId) {
      // Cache bot's Discord names for mention resolution
      const userId = this.bot.userId;
      if (this.bot.discord.user?.username) {
        this.userNameCache.set(this.bot.discord.user.username.toLowerCase(), userId);
        console.log(`[DiscordReadyReceptor:${botName}] Cached username: ${this.bot.discord.user.username} -> ${userId}`);
      }
      if (this.bot.discord.user?.displayName) {
        this.userNameCache.set(this.bot.discord.user.displayName.toLowerCase(), userId);
        console.log(`[DiscordReadyReceptor:${botName}] Cached displayName: ${this.bot.discord.user.displayName} -> ${userId}`);
      }
      // Also cache name variations (with dashes replaced by spaces)
      this.userNameCache.set(botName.toLowerCase(), userId);
      this.userNameCache.set(botName.toLowerCase().replace(/-/g, ' '), userId);

      // Emit discord:connected to register bot mapping on server
      try {
        await this.bot.grpcClient.emitDiscordConnected({
          botUserId: this.bot.userId,
          botId: botName,
          botUsername: this.bot.discord.user?.username || botName,
          botDisplayName: this.bot.discord.user?.displayName || botName
        });
        console.log(`[DiscordReadyReceptor:${botName}] Registered bot mapping on server`);
      } catch (error: any) {
        console.error(`[DiscordReadyReceptor:${botName}] Failed to register bot mapping:`, error.message);
      }
    }
  }
}
