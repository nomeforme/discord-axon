/**
 * Component Factory - Allows agents to create/manage components dynamically
 */

import type { IPersistentMetadata } from '@connectome/axon-interfaces';
import type { IAxonEnvironment } from 'connectome-ts';

export function createModule(env: IAxonEnvironment) {
  const { InteractiveComponent, Component } = env;

  class ComponentFactoryComponent extends InteractiveComponent {
    static persistentProperties: IPersistentMetadata[] = [];

    setupSubscriptions(): void {
      // Subscribe to component:add events
      this.subscribe('component:add');
      console.log('[ComponentFactory] Subscribed to component:add');
    }

    onRestore(): void {
      // Re-establish subscriptions after restoration
      this.setupSubscriptions();
      console.log('[ComponentFactory] Restored and re-subscribed');
    }

    async onMount(): Promise<void> {
      // Call parent to subscribe to frame:start (if it exists)
      if (super.onMount) {
        await super.onMount();
      }

      console.log('[ComponentFactory] Component mounted');
      this.setupSubscriptions();

      // Register actions with descriptions
      this.registerAction('createComponent', async (params: any) => {
        const { componentId, componentType, config } = params;

        if (!componentType) {
          console.error('[ComponentFactory] createComponent requires componentType');
          this.addEvent(
            `Failed to create component: componentType required`,
            'component-create-error',
            `component-error-${Date.now()}`,
            { streamId: 'component-factory' }
          );
          return;
        }

        console.log(`[ComponentFactory] Creating component: ${componentType} (${componentId})`);

        // Emit component:add event
        this.emit({
          topic: 'component:add',
          timestamp: Date.now(),
          payload: {
            componentId,
            componentType,
            config: config || {}
          }
        });

        this.addEvent(
          `Created component '${componentType}' (ID: ${componentId || 'auto'})`,
          'component-created',
          `component-created-${Date.now()}`,
          {
            streamId: 'component-factory',
            componentId,
            componentType
          }
        );
      });

      this.registerAction('createBox', async (params: any) => {
        const { boxName } = params;

        if (!boxName) {
          console.error('[ComponentFactory] createBox requires boxName');
          this.addEvent(
            `Failed to create box: boxName required`,
            'box-create-error',
            `box-error-${Date.now()}`,
            { streamId: 'component-factory' }
          );
          return;
        }

        const componentId = `box-${boxName.toLowerCase().replace(/\s+/g, '-')}`;

        console.log(`[ComponentFactory] Creating box: ${boxName} (${componentId})`);

        // Emit component:add for a box with AgentComponent
        this.emit({
          topic: 'component:add',
          timestamp: Date.now(),
          payload: {
            componentId: `${componentId}:AgentComponent`,
            componentType: 'AgentComponent',
            config: {
              agentConfig: {
                name: boxName,
                systemPrompt: `You are ${boxName}, a helpful box that can store and dispense items.`,
                autoActionRegistration: true
              }
            }
          }
        });

        this.addEvent(
          `Created box '${boxName}' (ID: ${componentId})`,
          'box-created',
          `box-created-${Date.now()}`,
          {
            streamId: 'component-factory',
            componentId,
            boxName
          }
        );
      });
    }
  }

  // Receptor to create action-definition facets when component-factory mounts
  // FLEX Component with priority 100 (Receptor level)
  class ComponentFactoryActionsReceptor extends Component {
    priority = 100;
    topics = ['component:mounted'];

    execute(context: any): void {
      const { event } = context;
      if (!event || event.topic !== 'component:mounted') return;

      const payload = event.payload;

      // Only process when ComponentFactoryComponent is mounted
      if (payload.componentType !== 'ComponentFactoryComponent') return;

      console.log('[ComponentFactoryActionsReceptor] ✨ Creating action-definition facets for component-factory!');

      const targetId = payload.componentId || 'component-factory';

      // Create action-definition facet for createComponent
      (this as any).addOperation({
        type: 'addFacet',
        facet: {
          id: `action-def-${targetId}-createComponent`,
          type: 'action-definition',
          displayName: 'component-factory.createComponent',
          attributes: {
            toolName: 'component-factory.createComponent',
            actionName: 'createComponent',
            targetId: 'component-factory',
            description: 'Create a new component with custom configuration',
            parameters: {
              type: 'object',
              properties: {
                componentId: { type: 'string', description: 'Unique ID for the component' },
                componentType: { type: 'string', description: 'Type of component to create' },
                config: { type: 'object', description: 'Configuration for the component' }
              },
              required: ['componentType']
            }
          }
        }
      });

      // Create action-definition facet for createBox
      (this as any).addOperation({
        type: 'addFacet',
        facet: {
          id: `action-def-${targetId}-createBox`,
          type: 'action-definition',
          displayName: 'component-factory.createBox',
          attributes: {
            toolName: 'component-factory.createBox',
            actionName: 'createBox',
            targetId: 'component-factory',
            description: 'Create a new box agent with the given name',
            parameters: {
              type: 'object',
              properties: {
                boxName: { type: 'string', description: 'Name of the box to create' }
              },
              required: ['boxName']
            }
          }
        }
      });
    }
  }

  return {
    components: {
      ComponentFactoryComponent,
      ComponentFactoryActionsReceptor
    }
  };
}
