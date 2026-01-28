import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

export interface DiscordConfig {
  botToken: string;
  guildId?: string;
  channelId?: string;
  httpPort?: number;
  wsPort?: number;
  modulePort?: number;
  debug?: boolean;
}

export function loadConfig(): DiscordConfig {
  // Check for multi-bot DISCORD_BOT_TOKENS first (comma-separated)
  // Use first token as the "primary" token for backwards compatibility
  const tokensEnv = process.env.DISCORD_BOT_TOKENS;
  if (tokensEnv) {
    const tokens = tokensEnv.split(',').map(t => t.trim()).filter(t => t);
    if (tokens.length > 0) {
      return {
        botToken: tokens[0],  // First token is the primary for legacy compatibility
        guildId: process.env.DISCORD_GUILD_ID,
        channelId: process.env.DISCORD_CHANNEL_ID,
        httpPort: parseInt(process.env.HTTP_PORT || '8080'),
        wsPort: parseInt(process.env.WS_PORT || '8081'),
        modulePort: parseInt(process.env.MODULE_PORT || '8082'),
        debug: process.env.DEBUG === 'true'
      };
    }
  }

  // Check legacy DISCORD_BOT_TOKEN
  if (process.env.DISCORD_BOT_TOKEN) {
    return {
      botToken: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID,
      channelId: process.env.DISCORD_CHANNEL_ID,
      httpPort: parseInt(process.env.HTTP_PORT || '8080'),
      wsPort: parseInt(process.env.WS_PORT || '8081'),
      modulePort: parseInt(process.env.MODULE_PORT || '8082'),
      debug: process.env.DEBUG === 'true'
    };
  }

  // Try to load from config file
  const configPaths = [
    join(process.cwd(), 'config.yaml'),
    join(process.cwd(), 'discord_config.yaml'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configContent = readFileSync(configPath, 'utf8');
        const config = yaml.load(configContent) as any;
        
        // Try discord.botToken first
        if (config.discord?.botToken) {
          return {
            botToken: config.discord.botToken,
            guildId: config.discord.guildId || config.adapter?.guild,
            channelId: config.discord.channelId || config.adapter?.channel,
            httpPort: config.discord.httpPort || 8080,
            wsPort: config.discord.wsPort || 8081,
            modulePort: config.discord.modulePort || 8082,
            debug: config.discord.debug || false
          };
        }
        
        // Try adapter.bot_token format (legacy)
        if (config.adapter?.bot_token) {
          return {
            botToken: config.adapter.bot_token,
            guildId: config.adapter?.guild,
            channelId: config.adapter?.channel,
            httpPort: config.discord?.httpPort || 8080,
            wsPort: config.discord?.wsPort || 8081,
            modulePort: config.discord?.modulePort || 8082,
            debug: config.discord?.debug || false
          };
        }
      } catch (error) {
        console.error(`Error loading config from ${configPath}:`, error);
      }
    }
  }

  throw new Error(
    'Discord bot token not found. Please set DISCORD_BOT_TOKEN environment variable ' +
    'or create a config.yaml file with discord.botToken'
  );
}
