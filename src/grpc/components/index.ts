/**
 * gRPC Components - Client-side equivalents of Connectome Components
 *
 * These classes maintain the Connectome nomenclature (Receptor, Transform, Effector)
 * while operating as gRPC clients rather than server-side Components.
 *
 * Architecture mapping:
 * - Receptors: Handle Discord events, emit to Connectome server
 * - Transforms: Fetch/render context from server
 * - Effectors: Handle commands, deliver speech to Discord
 */

// Receptors - Handle Discord events
export { DiscordReadyReceptor } from './discord-ready-receptor.js';
export type { DiscordReadyReceptorConfig } from './discord-ready-receptor.js';

export { DiscordMessageReceptor } from './discord-message-receptor.js';
export type { DiscordMessageReceptorConfig } from './discord-message-receptor.js';

export { DiscordInteractionReceptor } from './discord-interaction-receptor.js';
export type { DiscordInteractionReceptorConfig } from './discord-interaction-receptor.js';

export { DiscordReactionReceptor } from './discord-reaction-receptor.js';
export type { DiscordReactionReceptorConfig } from './discord-reaction-receptor.js';

// Transforms - Fetch and render context
export { FocusedContextTransform } from './focused-context-transform.js';
export type { FocusedContextTransformConfig, RenderedContext } from './focused-context-transform.js';

// Effectors - Send responses
export { DiscordCommandEffector } from './discord-command-effector.js';
export type { ConfigUpdateCallback } from './discord-command-effector.js';

export { DiscordSpeechEffector } from './discord-speech-effector.js';
export type { DiscordSpeechEffectorConfig } from './discord-speech-effector.js';
