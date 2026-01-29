/**
 * FocusedContextTransform - A ContextTransform that renders per-agent context
 *
 * Adapted from signal-axon-host's FocusedContextTransform. Key features:
 * 1. Filters frames by streamId (channel) to avoid cross-channel pollution
 * 2. Injects bot identity into system prompt per-activation
 * 3. Prevents context duplication where multiple bots see each other's identity
 */

import { Component, priorityConstraint } from 'connectome-ts';
import type { ReadonlyVEILState, ExecutionContext } from 'connectome-ts';
import type { VEILDelta, Facet } from 'connectome-ts';
import { FrameTrackingHUD } from 'connectome-ts/dist/hud/frame-tracking-hud.js';
import type { HUDConfig, RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';

// Helper to check if facet has state aspect
function hasStateAspect(facet: Facet): facet is Facet & { state: Record<string, any> } {
  return 'state' in facet && facet.state !== null && typeof facet.state === 'object';
}

export interface FocusedContextTransformConfig {
  defaultOptions?: Partial<HUDConfig>;
  // Maximum frames to process (applied globally before filtering)
  maxConversationFrames: number;
}

export class FocusedContextTransform extends Component {
  // Priority: Run after compression (which has priority 10)
  constraints = [priorityConstraint(100)];

  // Number of initial setup frames to always include regardless of stream
  private static readonly SETUP_FRAME_LIMIT = 5;

  private hud: FrameTrackingHUD;
  private defaultOptions?: Partial<HUDConfig>;
  private _maxConversationFrames: number;

  constructor(config?: FocusedContextTransformConfig) {
    super();
    this.defaultOptions = config?.defaultOptions;
    this._maxConversationFrames = config?.maxConversationFrames ?? 100;
    this.hud = new FrameTrackingHUD();
  }

  /** Get current max conversation frames setting */
  get maxConversationFrames(): number {
    return this._maxConversationFrames;
  }

  /** Set max conversation frames (for ComponentManager config injection) */
  set maxConversationFrames(value: number) {
    this._maxConversationFrames = value;
    console.log(`[FocusedContextTransform] maxConversationFrames set to ${value}`);
  }

  execute(context: ExecutionContext): void {
    const { state } = context;
    const deltas: VEILDelta[] = [];

    // Cache rendered context by streamId to avoid duplicate rendering
    const contextCache = new Map<string, RenderedContext>();

    // Find all agent-activation facets that need context rendered
    for (const [id, facet] of state.facets) {
      if (facet.type === 'agent-activation' && hasStateAspect(facet)) {
        const activationState = facet.state as Record<string, any>;

        // Skip if context already rendered for this activation
        const contextExists = Array.from(state.facets.values()).some(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === id
        );

        if (contextExists) continue;

        // Get the focused stream from the activation
        // Note: createAgentActivation puts extra options under metadata
        const focusedStreamId = activationState.metadata?.streamRef?.streamId || activationState.streamRef?.streamId;

        // Check if we already rendered context for this stream in this pass
        const cachedContext = focusedStreamId ? contextCache.get(focusedStreamId) : undefined;

        if (cachedContext) {
          // Reuse cached context - just create a new facet referencing it
          const botName = activationState.metadata?.targetAgent || activationState.targetAgent;
          console.log(`[FocusedContextTransform] Reusing cached context for ${botName} (stream ${focusedStreamId})`);

          const contextFacetId = `context-${id}-${Date.now()}`;
          deltas.push({
            type: 'addFacet',
            facet: {
              id: contextFacetId,
              type: 'rendered-context',
              state: {
                activationId: id,
                tokenCount: cachedContext.metadata.totalTokens,
                context: cachedContext
              }
            }
          });
          continue;
        }

        // Get VEILStateManager from Space
        const space = this.space as any;

        if (!space || !space.getVEILStateManager) {
          console.error('[FocusedContextTransform] Cannot access VEILStateManager');
          continue;
        }

        const veilStateManager = space.getVEILStateManager();
        const fullState = veilStateManager.getState();

        // Get current frame from Space
        const currentFrame = space?.getCurrentFrame();

        // PRE-CLIP: Limit total frames to process
        const maxFrames = this._maxConversationFrames;
        const frameHistory = fullState.frameHistory.length > maxFrames
          ? fullState.frameHistory.slice(-maxFrames)
          : fullState.frameHistory;

        if (fullState.frameHistory.length > maxFrames) {
          console.log(`[FocusedContextTransform] Pre-clipped ${fullState.frameHistory.length} frames to ${maxFrames}`);
        }

        // FILTER FRAMES: Only include frames that match the focused stream
        const filteredFrames = frameHistory.filter((frame: any) => {
          // If no focused stream specified, include everything
          if (!focusedStreamId) return true;

          // If frame has a stream, it must match
          if (frame.activeStream?.streamId) {
            return frame.activeStream.streamId === focusedStreamId;
          }

          // Include very early setup frames ONLY if they don't have a stream
          if (frame.sequence <= FocusedContextTransform.SETUP_FRAME_LIMIT) {
            return true;
          }

          // Check if frame contains any facets for the focused stream
          if (frame.deltas) {
            for (const delta of frame.deltas) {
              if (delta.type === 'addFacet' && delta.facet?.streamId === focusedStreamId) {
                return true;
              }
            }
          }

          return false;
        });

        console.log(`[FocusedContextTransform] Filtered ${frameHistory.length} frames to ${filteredFrames.length} for stream ${focusedStreamId}`);

        // Add current frame if it matches
        const allFrames = [...filteredFrames];
        if (currentFrame) {
          const isAlreadyInHistory = filteredFrames.some((f: any) => f.sequence === currentFrame.sequence);
          if (!isAlreadyInHistory) {
            if (!currentFrame.activeStream?.streamId ||
                !focusedStreamId ||
                currentFrame.activeStream.streamId === focusedStreamId) {
              allFrames.push(currentFrame);
            }
          }
        }

        // Get bot name from targetAgent (set by DiscordMessageReceptor)
        // Note: createAgentActivation puts extra options under metadata
        const botName = activationState.metadata?.targetAgent || activationState.targetAgent;

        // Build system prompt with bot identity and Discord capabilities
        const systemPrompt = botName
          ? `You are <${botName}> in Discord.

To mention users or other bots, use <@username> syntax. The system will convert usernames to Discord IDs automatically.`
          : activationState.systemPrompt || this.defaultOptions?.systemPrompt;

        // Build agent options
        const agentOptions: HUDConfig = {
          ...this.defaultOptions,
          systemPrompt,
          maxTokens: activationState.maxTokens || this.defaultOptions?.maxTokens || 4000,
          metadata: this.defaultOptions?.metadata,
          renderContext: {
            ...this.defaultOptions?.renderContext,
            focusedStream: focusedStreamId
          }
        };

        // Render context with filtered frames
        const renderedContext = this.hud.render(
          allFrames,
          fullState.facets,
          veilStateManager,
          undefined,
          agentOptions
        );

        // Inject system prompt by APPENDING to existing system message
        if (agentOptions.systemPrompt) {
          const existingSystemMsg = renderedContext.messages.find((m: any) => m.role === 'system');
          if (existingSystemMsg) {
            existingSystemMsg.content = `${existingSystemMsg.content}\n\n${agentOptions.systemPrompt}`;
            console.log(`[FocusedContextTransform] Appended system prompt for ${botName}`);
          } else {
            renderedContext.messages.unshift({
              role: 'system',
              content: agentOptions.systemPrompt
            });
            console.log(`[FocusedContextTransform] Created new system message for ${botName}`);
          }
        }

        // Cache the rendered context for this stream
        if (focusedStreamId) {
          contextCache.set(focusedStreamId, renderedContext);
        }

        // Create rendered-context facet
        const contextFacetId = `context-${id}-${Date.now()}`;

        deltas.push({
          type: 'addFacet',
          facet: {
            id: contextFacetId,
            type: 'rendered-context',
            state: {
              activationId: id,
              tokenCount: renderedContext.metadata.totalTokens,
              context: renderedContext
            }
          }
        });
      }
    }

    // Add all deltas via addOperation
    for (const delta of deltas) {
      this.addOperation(delta);
    }
  }
}
