/**
 * DiscordInteractionReceptor - Handles Discord interaction events
 *
 * Processes slash commands, button clicks, and other interactions:
 * - Ensures stream exists for the channel
 * - Emits interaction to Connectome server
 * - Defers replies for slash commands
 *
 * This follows the receptor pattern for handling specific event types.
 */

import type { Interaction } from 'discord.js';
import type { BotInstance } from '../types.js';

export interface DiscordInteractionReceptorConfig {
  bot: BotInstance;
}

/**
 * DiscordInteractionReceptor - Handles Discord interactions
 *
 * Constraint equivalent: RECEPTOR priority
 */
export class DiscordInteractionReceptor {
  private bot: BotInstance;

  constructor(config: DiscordInteractionReceptorConfig) {
    this.bot = config.bot;
  }

  /**
   * Set up the Discord interaction event listener
   */
  setup(): void {
    const botName = this.bot.config.name;

    this.bot.discord.on('interactionCreate', async (interaction: Interaction) => {
      await this.handleInteraction(interaction);
    });

    console.log(`[DiscordInteractionReceptor:${botName}] Interaction handler registered`);
  }

  /**
   * Handle Discord interaction
   */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    const botName = this.bot.config.name;

    try {
      if (interaction.isChatInputCommand()) {
        // Ensure stream exists
        await this.bot.streamManager.getOrCreateStream(
          interaction.channelId,
          {
            guildId: interaction.guildId ?? undefined,
            guildName: interaction.guild?.name ?? undefined
          }
        );

        // Emit slash command interaction
        await this.bot.grpcClient.emitDiscordInteraction({
          type: 'slash-command',
          commandName: interaction.commandName,
          options: [...interaction.options.data],
          userId: interaction.user.id,
          userName: interaction.user.username,
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          interactionId: interaction.id,
          timestamp: interaction.createdTimestamp
        });

        // Defer reply
        await interaction.deferReply();

      } else if (interaction.isButton()) {
        await this.bot.grpcClient.emitDiscordInteraction({
          type: 'button',
          customId: interaction.customId,
          userId: interaction.user.id,
          userName: interaction.user.username,
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          interactionId: interaction.id,
          timestamp: interaction.createdTimestamp
        });
      }
    } catch (error: any) {
      console.error(`[DiscordInteractionReceptor:${botName}] Error handling interaction:`, error.message);
    }
  }
}
