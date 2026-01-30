/**
 * DiscordReadyReceptor - Handles Discord ready event
 *
 * Sets up the bot when Discord connection is established:
 * - Caches bot user ID and names
 * - Registers bot mapping on Connectome server
 * - Triggers auto-join for configured channels
 *
 * This is separated from DiscordMessageReceptor for clarity,
 * following the pattern of having receptors handle specific event types.
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
   */
  private async handleReady(): Promise<void> {
    const botName = this.bot.config.name;

    console.log(`[DiscordReadyReceptor:${botName}] Logged in as ${this.bot.discord.user?.tag}`);
    this.bot.userId = this.bot.discord.user?.id;

    if (this.bot.userId) {
      // Register in shared state
      this.state.botUserIdToName.set(this.bot.userId, botName);

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
      // Also cache config name variations
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
