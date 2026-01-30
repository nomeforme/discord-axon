/**
 * Configuration loading for Discord AXON gRPC mode
 */

import fs from 'fs';
import path from 'path';
import type { DiscordConfig, BotConfig } from './types.js';

/**
 * Load configuration from config.json
 */
export function loadConfig(): DiscordConfig {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch (err: any) {
    console.error('Error loading config.json:', err.message);
    process.exit(1);
  }
}

/**
 * Parse tokens from environment and pair with bot configs
 */
export function pairTokensWithBots(config: DiscordConfig): BotConfig[] {
  const tokensEnv = process.env.DISCORD_BOT_TOKENS || '';
  const tokens = tokensEnv.split(',').map(t => t.trim()).filter(t => t);
  const activeBots = config.active_bots || [];

  if (tokens.length === 0) {
    console.error('Error: DISCORD_BOT_TOKENS environment variable not set');
    process.exit(1);
  }

  console.log(`Found ${tokens.length} token(s) in DISCORD_BOT_TOKENS`);

  if (tokens.length !== activeBots.length) {
    console.warn(`Warning: ${tokens.length} tokens but ${activeBots.length} active_bots`);
  }

  const pairedBots: BotConfig[] = [];

  for (let i = 0; i < Math.min(tokens.length, activeBots.length); i++) {
    const botName = activeBots[i];
    const botConfig = config.bots.find(b => b.name === botName);

    if (botConfig) {
      pairedBots.push({
        ...botConfig,
        token: tokens[i]
      });
      console.log(`  ${botName}: token assigned`);
    } else {
      console.warn(`  Warning: Bot '${botName}' not found in config.bots`);
    }
  }

  return pairedBots;
}

/**
 * Parse gRPC host from environment
 */
export function getGrpcConfig(): { host: string; port: number } {
  const grpcHost = process.env.CONNECTOME_GRPC_HOST || 'localhost:50051';
  const [host, portStr] = grpcHost.split(':');
  const port = parseInt(portStr) || 50051;
  return { host, port };
}
