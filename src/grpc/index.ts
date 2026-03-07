/**
 * Discord AXON gRPC exports
 */

// Core clients
export { DiscordGrpcClient, type DiscordGrpcClientConfig } from './client.js';
export { StreamManager, type StreamInfo } from './stream-manager.js';

// Types
export * from './types.js';

// Configuration
export { getTokens, getGrpcConfig, getOperationalConfig } from './config-loader.js';

// Bot instance management
export { createDiscordClient, createBotInstance } from './bot-instance.js';

// Components (class-based, Connectome nomenclature)
export * from './components/index.js';

// Utilities
export * from './utils/index.js';
