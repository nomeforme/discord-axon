/**
 * DiscordAgentEffector - Processes agent activations with native tool support
 *
 * This is a custom effector that replaces AgentEffector for Discord bots,
 * using ToolLoopAgent instead of BasicAgent to support native tool calling.
 *
 * Adapted from signal-axon-host's ToolAgentEffector.
 */

import { Component, priorityConstraint, ComponentPriority } from 'connectome-ts';
import type {
  FacetDelta,
  ReadonlyVEILState,
  FacetFilter,
  ExecutionContext
} from 'connectome-ts';
import type {
  Facet,
  StreamRef
} from 'connectome-ts';
import { hasStateAspect } from 'connectome-ts/dist/veil/types.js';
import type { RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';
import { ToolLoopAgent } from './tool-loop-agent.js';

export interface DiscordErrorConfig {
  // Discord afferent reference for sending error messages
  getAfferent?: () => any;
}

export class DiscordAgentEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  facetFilters: FacetFilter[] = [
    { type: 'agent-activation' },
    { type: 'rendered-context' }
  ];

  private agent: ToolLoopAgent;
  private agentName: string;
  private botId: string;
  private processingActivations = new Set<string>();
  private errorConfig?: DiscordErrorConfig;

  constructor(agent: ToolLoopAgent, agentName: string, botId: string, errorConfig?: DiscordErrorConfig) {
    super();
    this.agent = agent;
    this.agentName = agentName;
    this.botId = botId;
    this.errorConfig = errorConfig;
  }

  execute(context: ExecutionContext): void {
    const { state, frame } = context;
    if (!frame?.deltas) return;

    for (const delta of frame.deltas) {
      if (delta.type !== 'addFacet') continue;

      if (delta.facet.type === 'agent-activation') {
        const activationId = delta.facet.id;
        const activationState = hasStateAspect(delta.facet)
          ? (delta.facet.state as Record<string, any>)
          : {};

        // Skip if already processing
        if (this.processingActivations.has(activationId)) continue;

        // Check if this activation targets this agent
        // targetAgent can be in activationState directly or in metadata
        const targetAgent = (activationState.targetAgent || activationState.metadata?.targetAgent) as string | undefined;
        if (targetAgent && targetAgent !== this.agentName) {
          continue;
        }

        // Look for corresponding rendered context
        const contextFacet = Array.from(state.facets.values()).find(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === activationId
        );

        if (!contextFacet || !hasStateAspect(contextFacet)) {
          // No context yet, will process in next frame
          continue;
        }

        // Mark as processing
        this.processingActivations.add(activationId);

        // Get stream info
        const flattenedActivation = {
          ...activationState,
          ...(activationState.metadata || {})
        };
        const streamRef = flattenedActivation.streamRef as StreamRef | undefined;
        const streamId = streamRef?.streamId ?? (flattenedActivation.streamId as string | undefined) ?? 'default';

        // Get the context
        const contextState = contextFacet.state as { context: RenderedContext };
        const renderedContext = contextState.context;

        // Run agent cycle in background
        this.runAgentCycleBackground(renderedContext, streamRef, activationId, streamId, state);
      }
    }
  }

  private runAgentCycleBackground(
    context: RenderedContext,
    streamRef: StreamRef | undefined,
    activationId: string,
    streamId: string,
    state: ReadonlyVEILState
  ): void {
    (async () => {
      try {
        console.log(`[DiscordAgentEffector:${this.agentName}] Running agent cycle for activation ${activationId}...`);

        // Run the tool-loop agent cycle
        const result = await this.agent.runCycle(context, streamRef);

        console.log(`[DiscordAgentEffector:${this.agentName}] Agent cycle completed with ${result.operations.length} operations`);

        // Emit facets via veil:operation
        for (const operation of result.operations) {
          if (operation.type === 'addFacet') {
            const facet = this.prepareFacet(operation.facet, streamRef);
            console.log(`[DiscordAgentEffector:${this.agentName}] Emitting facet: ${facet.type} (${facet.id})`);
            if (facet.type === 'speech') {
              console.log(`[DiscordAgentEffector:${this.agentName}] Speech content:\n---\n${(facet as any).content}\n---`);
            }

            this.emit({
              topic: 'veil:operation',
              payload: {
                operation: {
                  type: 'addFacet',
                  facet
                }
              }
            });
          }
        }

        // Clean up rendered-context facet to save memory
        const contextFacetToDelete = Array.from(state.facets.values()).find(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === activationId
        );
        if (contextFacetToDelete) {
          this.emit({
            topic: 'veil:operation',
            payload: {
              operation: {
                type: 'deleteFacet',
                facetId: contextFacetToDelete.id
              }
            }
          });
          console.log(`[DiscordAgentEffector:${this.agentName}] Deleted rendered-context facet ${contextFacetToDelete.id}`);
        }

        console.log(`[DiscordAgentEffector:${this.agentName}] Cycle complete`);

      } catch (error) {
        console.error(`[DiscordAgentEffector:${this.agentName}] Agent cycle error:`, error);

        // Emit error as a speech facet so it appears in Discord
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emitErrorSpeech(errorMessage, streamRef);
      } finally {
        this.processingActivations.delete(activationId);
      }
    })();
  }

  private prepareFacet(facet: Facet, streamRef?: StreamRef): Facet {
    const prepared = { ...facet } as Facet;

    // Ensure agentId and agentName are set
    if (!prepared.agentId) {
      (prepared as any).agentId = this.agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    if (!(prepared as any).agentName) {
      (prepared as any).agentName = this.agentName;
    }

    // Ensure streamId is set
    if (streamRef?.streamId && !prepared.streamId) {
      (prepared as any).streamId = streamRef.streamId;
    }

    return prepared;
  }

  /**
   * Emit error as a speech facet so it shows up in Discord
   */
  private emitErrorSpeech(errorMessage: string, streamRef?: StreamRef): void {
    const facet: Facet = {
      id: `error-speech-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'speech',
      content: `Error: ${errorMessage}`,
      agentId: this.agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      agentName: this.agentName,
      streamId: streamRef?.streamId || 'default'
    } as Facet;

    this.emit({
      topic: 'veil:operation',
      payload: {
        operation: {
          type: 'addFacet',
          facet
        }
      }
    });
  }

  /**
   * Get agent name
   */
  getName(): string {
    return this.agentName;
  }

  /**
   * Get bot ID
   */
  getBotId(): string {
    return this.botId;
  }
}
