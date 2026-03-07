/**
 * Configuration loading for Discord AXON gRPC mode
 *
 * No static config.json — bot identities are discovered from Discord on login.
 * Tokens from env vars, operational params from env vars with defaults.
 */

/**
 * Parse Discord bot tokens from environment
 */
export function getTokens(): string[] {
  const tokensEnv = process.env.DISCORD_BOT_TOKENS || '';
  const tokens = tokensEnv.split(',').map(t => t.trim()).filter(t => t);

  if (tokens.length === 0) {
    console.log('No DISCORD_BOT_TOKENS set — bots will arrive via axon binding');
  } else {
    console.log(`Found ${tokens.length} token(s) in DISCORD_BOT_TOKENS`);
  }

  return tokens;
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

/**
 * Parse operational config from environment with defaults
 */
export function getOperationalConfig(): {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  maxMessageLength: number;
} {
  return {
    randomReplyChance: parseInt(process.env.RANDOM_REPLY_CHANCE || '200') || 200,
    maxBotMentionsPerConversation: parseInt(process.env.MAX_BOT_MENTIONS || '1') || 1,
    maxConversationFrames: parseInt(process.env.MAX_CONVERSATION_FRAMES || '100') || 100,
    maxMemoryFrames: 500,
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '2000') || 2000,
  };
}
