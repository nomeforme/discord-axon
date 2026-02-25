/**
 * Discord Control Panel Component
 *
 * Provides UI and actions for managing Discord server/channel connections
 * Uses direct afferent calls for simpler architecture
 */

// Import types
import type { IAxonEnvironment, SpaceEvent } from '@connectome/connectome-ts';
import type { IPersistentMetadata } from '@connectome/axon-interfaces';

// Guild and channel info types
interface GuildInfo {
  id: string;
  name: string;
  icon?: string;
  memberCount?: number;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: number; // 0 = text, 2 = voice, etc
  guildId: string;
  guildName: string;
  position: number;
  parentId?: string; // Category ID
  topic?: string;
}

interface CategoryInfo {
  id: string;
  name: string;
  channels: ChannelInfo[];
}

// Module factory function
export function createModule(env: IAxonEnvironment): typeof env.ControlPanelComponent {
  const {
    ControlPanelComponent,
    persistent,
    external
  } = env;

  class DiscordControlPanelComponent extends ControlPanelComponent {
    // Panel configuration
    protected getPanelId() { return 'discord-control'; }
    protected getPanelDisplayName() { return 'Discord Control'; }

    // Discord-specific state
    @persistent
    private availableGuilds: GuildInfo[] = [];

    @persistent
    private availableChannels: Record<string, ChannelInfo[]> = {}; // guildId -> channels

    @persistent
    private joinedChannels: Set<string> = new Set();

    @persistent
    private selectedGuildId?: string;

    @persistent
    private showCategories: boolean = true;

    // Discord component reference (lazy loaded)
    private discordComponent?: any;
    private discordComponentId?: string;

    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'availableGuilds' },
      { propertyKey: 'availableChannels' },
      { propertyKey: 'joinedChannels' },
      { propertyKey: 'selectedGuildId' },
      { propertyKey: 'showCategories' }
    ];

    protected async onPanelOpened() {
      console.log('[DiscordControlPanel] Panel opened');
      // Optionally auto-fetch server list when panel opens
      // await this.listGuilds();
    }

    protected async onPanelClosed() {
      console.log('[DiscordControlPanel] Panel closed');
      // Result facets are now scoped to panel and will be hidden automatically
    }

    async onMount(): Promise<void> {
      console.log('[DiscordControlPanel] Component mounted');

      // Call super to register open/close actions
      await super.onMount();
      console.log('[DiscordControlPanel] super.onMount() completed');

      // Subscribe to Discord events (results come back as events)
      this.subscribe('discord:connected');
      this.subscribe('discord:guilds-list');
      this.subscribe('discord:channels-list');
      this.subscribe('discord:channel-joined');
      this.subscribe('discord:channel-left');

      // Register panel tools (automatically scoped)
      this.registerPanelTool(
        'listServers',
        async () => { await this.listGuilds(); },
        'List Discord servers: {@discord-control.listServers()}',
        { description: 'Lists all Discord servers the bot has access to' }
      );

      this.registerPanelTool('listChannels', async (params: any) => {
        const serverName = params?.serverName || this.getSelectedServerName();
        if (!serverName) {
          this.emitControlError(
            'discord-error-no-server',
            'No server selected. Use listServers first, then selectServer.',
            { ttl: 5000 }
          );
          return;
        }

        const guild = this.findGuildByName(serverName);
        if (!guild) {
          this.emitControlError(
            'discord-error-unknown-server',
            `Unknown server: ${serverName}`,
            { ttl: 5000 }
          );
          return;
        }

        await this.listChannels(guild.id);
      }, 'List channels: {@discord-control.listChannels(serverName="MyServer")}', {
        description: 'Lists channels in the selected or specified server',
        params: { serverName: { type: 'string', required: false } }
      });

      this.registerPanelTool('joinChannel', async (params: any) => {
        // Support both channelId and channelName
        let channelId: string;

        if (params?.channelId) {
          // Direct ID provided - use it immediately
          channelId = params.channelId;
          console.log(`[DiscordControlPanel] Joining channel by ID: ${channelId}`);
        } else if (params?.channelName) {
          // Name provided - need to resolve it
          const serverName = params.serverName || this.getSelectedServerName();
          if (!serverName) {
            this.emitControlError(
              'discord-error-no-server-join',
              'No server specified. Provide serverName or select a server first.',
              { ttl: 5000 }
            );
            return;
          }

          const channel = this.findChannelByName(params.channelName, serverName);
          if (!channel) {
            this.emitControlError(
              'discord-error-unknown-channel',
              `Channel #${params.channelName} not found in server ${serverName}`,
              { ttl: 5000 }
            );
            return;
          }
          channelId = channel.id;
          console.log(`[DiscordControlPanel] Resolved channel name "${params.channelName}" to ID: ${channelId}`);
        } else {
          this.emitControlError(
            'discord-error-no-channel',
            'No channel name or ID provided',
            { ttl: 5000 }
          );
          return;
        }

        await this.joinChannel(channelId);
      }, 'Join channel: {@discord-control.joinChannel(channelName="general", serverName="MyServer")} or {@discord-control.joinChannel(channelId="123456789")}', {
        description: 'Joins a Discord channel to receive messages. Can use channel name (requires server) or direct channel ID.',
        params: {
          channelName: { type: 'string', required: false },
          channelId: { type: 'string', required: false },
          serverName: { type: 'string', required: false }
        }
      });

      this.registerPanelTool('leaveChannel', async (params: any) => {
        // Support both channelId and channelName
        let channelId: string;

        if (params?.channelId) {
          // Direct ID provided - verify we're in this channel
          if (!this.joinedChannels.has(params.channelId)) {
            this.emitControlError(
              'discord-error-not-in-channel',
              `Not in channel with ID: ${params.channelId}`,
              { ttl: 5000 }
            );
            return;
          }
          channelId = params.channelId;
          console.log(`[DiscordControlPanel] Leaving channel by ID: ${channelId}`);
        } else if (params?.channelName) {
          // Name provided - need to resolve it
          let targetChannel: ChannelInfo | undefined;
          for (const joinedChannelId of this.joinedChannels) {
            const channel = this.findChannel(joinedChannelId);
            if (channel && channel.name === params.channelName) {
              if (!params.serverName || channel.guildName === params.serverName) {
                targetChannel = channel;
                break;
              }
            }
          }

          if (!targetChannel) {
            this.emitControlError(
              'discord-error-not-in-channel',
              `Not in channel #${params.channelName}${params.serverName ? ` in ${params.serverName}` : ''}`,
              { ttl: 5000 }
            );
            return;
          }
          channelId = targetChannel.id;
          console.log(`[DiscordControlPanel] Resolved channel name "${params.channelName}" to ID: ${channelId}`);
        } else {
          this.emitControlError(
            'discord-error-no-channel-leave',
            'No channel name or ID provided',
            { ttl: 5000 }
          );
          return;
        }

        await this.leaveChannel(channelId);
      }, 'Leave channel: {@discord-control.leaveChannel(channelName="general")} or {@discord-control.leaveChannel(channelId="123456789")}', {
        description: 'Leaves a previously joined Discord channel. Can use channel name or direct channel ID.',
        params: {
          channelName: { type: 'string', required: false },
          channelId: { type: 'string', required: false },
          serverName: { type: 'string', required: false }
        }
      });

      this.registerPanelTool('showJoinedChannels', async () => {
        await this.showJoinedChannels();
      }, 'Show joined channels: {@discord-control.showJoinedChannels()}', {
        description: 'Displays all currently joined Discord channels'
      });

      this.registerPanelTool('selectServer', async (params: any) => {
        if (!params?.serverName) {
          this.emitControlError(
            'discord-error-no-server-select',
            'No server name provided',
            { ttl: 5000 }
          );
          return;
        }

        const guild = this.findGuildByName(params.serverName);
        if (!guild) {
          this.emitControlError(
            'discord-error-unknown-server-select',
            `Unknown server: ${params.serverName}`,
            { ttl: 5000 }
          );
          return;
        }

        this.selectedGuildId = guild.id;
        this.createControlPanelFacet();
        await this.listChannels(guild.id);
      }, 'Select server: {@discord-control.selectServer(serverName="MyServer")}', {
        description: 'Selects a Discord server for subsequent operations',
        params: { serverName: { type: 'string', required: true } }
      });

      this.registerPanelTool('sendMessage', async (params: any) => {
        if (!params?.message) {
          this.emitControlError(
            'discord-error-no-message',
            'No message content provided',
            { ttl: 5000 }
          );
          return;
        }

        if (!params?.channelName) {
          this.emitControlError(
            'discord-error-no-channel-send',
            'No channel name provided',
            { ttl: 5000 }
          );
          return;
        }

        const serverName = params.serverName || this.getSelectedServerName();
        if (!serverName) {
          this.emitControlError(
            'discord-error-no-server-send',
            'No server specified. Provide serverName or select a server first.',
            { ttl: 5000 }
          );
          return;
        }

        const channel = this.findChannelByName(params.channelName, serverName);
        if (!channel) {
          this.emitControlError(
            'discord-error-unknown-channel-send',
            `Channel #${params.channelName} not found in server ${serverName}`,
            { ttl: 5000 }
          );
          return;
        }

        await this.sendMessage(channel.id, params.message);
      }, 'Send message: {@discord-control.sendMessage(channelName="general", message="Hello!", serverName="MyServer")}', {
        description: 'Sends a message to a Discord channel',
        params: {
          channelName: { type: 'string', required: true },
          message: { type: 'string', required: true },
          serverName: { type: 'string', required: false }
        }
      });

      // Emit tools-registered event for receptors to create facets declaratively
      await this.onMountComplete();
    }

    async handleEvent(event: SpaceEvent): Promise<void> {
      // Call parent to handle frame:start subscription
      await super.handleEvent(event);

      switch (event.topic) {

        case 'discord:connected':
          // Request guild list on connection
          console.log('[DiscordControlPanel] Discord connected, auto-fetching guild list');
          setTimeout(() => this.listGuilds(), 1000);
          break;

        case 'discord:guilds-list':
          this.handleGuildsList(event.payload as any);
          break;

        case 'discord:channels-list':
          this.handleChannelsList(event.payload as any);
          break;

        case 'discord:channel-joined':
          this.handleChannelJoined(event.payload as any);
          break;

        case 'discord:channel-left':
          this.handleChannelLeft(event.payload as any);
          break;
      }
    }

    // ============================================
    // Discord Actions (Direct Afferent Calls)
    // ============================================

    private async listGuilds(): Promise<void> {
      console.log('[DiscordControlPanel] Requesting guild list via direct afferent call');

      const afferent = this.getDiscordAfferent();
      if (!afferent || typeof (afferent as any).listGuilds !== 'function') {
        this.emitControlError(
          'discord-not-ready',
          'Discord not connected or listGuilds not available',
          { ttl: 5000 }
        );
        return;
      }

      // Call afferent method directly
      await (afferent as any).listGuilds({});
      // Result arrives via discord:guilds-list event
    }

    private async listChannels(guildId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting channels for guild ${guildId} via direct afferent call`);

      const afferent = this.getDiscordAfferent();
      if (!afferent || typeof (afferent as any).listChannels !== 'function') {
        this.emitControlError(
          'discord-not-ready-channels',
          'Discord not connected or listChannels not available',
          { ttl: 5000 }
        );
        return;
      }

      // Call afferent method directly
      await (afferent as any).listChannels({ guildId });
      // Result arrives via discord:channels-list event
    }

    private async joinChannel(channelId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting to join channel ${channelId} via direct afferent call`);

      // Find channel info
      const channel = this.findChannel(channelId);
      if (!channel) {
        this.emitControlError(
          'discord-error-unknown-channel',
          `Unknown channel ID: ${channelId}`,
          { ttl: 5000 }
        );
        return;
      }

      const afferent = this.getDiscordAfferent();
      if (!afferent || typeof (afferent as any).join !== 'function') {
        this.emitControlError(
          'discord-not-ready-join',
          'Discord not connected or join not available',
          { ttl: 5000 }
        );
        return;
      }

      // Call afferent method directly
      await (afferent as any).join({ channelId });
      // Result arrives via discord:channel-joined event
    }

    private async leaveChannel(channelId: string): Promise<void> {
      console.log(`[DiscordControlPanel] Requesting to leave channel ${channelId} via direct afferent call`);

      const afferent = this.getDiscordAfferent();
      if (!afferent || typeof (afferent as any).leave !== 'function') {
        this.emitControlError(
          'discord-not-ready-leave',
          'Discord not connected or leave not available',
          { ttl: 5000 }
        );
        return;
      }

      // Call afferent method directly
      await (afferent as any).leave({ channelId });
      // Result arrives via discord:channel-left event
    }

    private async sendMessage(channelId: string, message: string): Promise<void> {
      console.log(`[DiscordControlPanel] Sending message to channel ${channelId}`);

      const afferent = this.getDiscordAfferent();
      if (!afferent || typeof (afferent as any).send !== 'function') {
        this.emitControlError(
          'discord-not-ready-send',
          'Discord not connected or send not available',
          { ttl: 5000 }
        );
        return;
      }

      // Call afferent method directly
      try {
        await (afferent as any).send({ channelId, message });

        // Emit success event
        this.emit({
          topic: 'discord:message-sent',
          timestamp: Date.now(),
          payload: {
            channelId,
            message,
            success: true
          }
        });

        this.reactivateAgent('Message sent successfully');
      } catch (error) {
        this.emitControlError(
          'discord-send-error',
          `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
          { ttl: 5000 }
        );
      }
    }

    private async showJoinedChannels(): Promise<void> {
      const joinedList = Array.from(this.joinedChannels).map(channelId => {
        const channel = this.findChannel(channelId);
        return channel ? `${channel.guildName}:#${channel.name}` : channelId;
      });

      const resultId = `discord-result-joined-${Date.now()}`;

      this.addFacet({
        id: resultId,
        type: 'state',
        content: joinedList.length > 0
          ? `Currently in ${joinedList.length} channel(s):\n${joinedList.join('\n')}`
          : 'Not in any channels',
        scope: [this.getPanelScope()],
        attributes: {
          entityType: 'component',
          entityId: this.id,
          channels: Array.from(this.joinedChannels),
          count: this.joinedChannels.size
        }
      });

      this.reactivateAgent('Joined channels retrieved');
    }

    // ============================================
    // Event Handlers (Results from Afferent)
    // ============================================

    private handleGuildsList(payload: { guilds: GuildInfo[] }): void {
      if (!payload || !payload.guilds) {
        console.warn('[DiscordControlPanel] Received invalid guilds payload:', payload);
        return;
      }
      this.availableGuilds = payload.guilds;
      console.log(`[DiscordControlPanel] Received ${payload.guilds.length} guilds`);

      // Update main panel UI
      this.createControlPanelFacet();

      // Result facet is now created declaratively by DiscordGuildsListReceptor
      // Re-activate agent so it sees the results
      this.reactivateAgent('Server list retrieved');
    }

    private handleChannelsList(payload: { guildId: string; channels: ChannelInfo[] }): void {
      if (!payload || !payload.channels || !payload.guildId) {
        console.warn('[DiscordControlPanel] Received invalid channels payload:', payload);
        return;
      }
      this.availableChannels[payload.guildId] = payload.channels;
      console.log(`[DiscordControlPanel] Received ${payload.channels.length} channels for guild ${payload.guildId}`);

      // Update main panel UI
      this.createControlPanelFacet();

      // Result facet is now created declaratively by DiscordChannelsListReceptor
      const guild = this.availableGuilds.find((g: any) => g.id === payload.guildId);

      // Re-activate agent so it sees the results
      this.reactivateAgent(`Channel list retrieved for ${guild?.name || payload.guildId}`);
    }

    private handleChannelJoined(payload: any): void {
      // Handle successful channel join - payload is the channel object
      if (payload && payload.id) {
        this.joinedChannels.add(payload.id);
        console.log(`[DiscordControlPanel] Successfully joined channel ${payload.id}`);

        // Result facet is now created declaratively by DiscordChannelJoinedReceptor

        // Only activate agent if panel is open (auto-joins during boot happen while closed)
        if (this.isOpen) {
          this.reactivateAgent(`Joined channel #${payload.name}`);
          console.log(`[DiscordControlPanel] Panel open - agent activated for join`);
        } else {
          console.log(`[DiscordControlPanel] Panel closed - skipping agent activation (likely auto-join)`);
        }
      } else {
        console.error(`[DiscordControlPanel] Invalid channel joined payload:`, payload);
        this.emitControlError(
          'discord-join-error-invalid',
          'Failed to join channel: Invalid payload received',
          { ttl: 5000 }
        );
      }

      // Update UI
      this.createControlPanelFacet();
    }

    private handleChannelLeft(payload: { channelId: string }): void {
      this.joinedChannels.delete(payload.channelId);
      console.log(`[DiscordControlPanel] Left channel ${payload.channelId}`);

      // Result facet is now created declaratively by DiscordChannelLeftReceptor
      const channel = this.findChannel(payload.channelId);

      // Re-activate agent
      this.reactivateAgent(`Left channel ${channel ? `#${channel.name}` : payload.channelId}`);

      // Update UI
      this.createControlPanelFacet();
    }

    // ============================================
    // UI Formatting
    // ============================================

    private createControlPanelFacet(): void {
      const selectedGuild = this.availableGuilds.find((g: any) => g.id === this.selectedGuildId);
      const channels = this.selectedGuildId ? (this.availableChannels[this.selectedGuildId] || []) : [];

      this.updateState('discord-control-panel', {
        content: this.formatControlPanel(),
        attributes: {
          guilds: this.availableGuilds,
          selectedGuild: selectedGuild,
          channels: channels,
          joinedChannels: Array.from(this.joinedChannels)
        }
      });
    }

    private formatControlPanel(): string {
      const parts: string[] = ['Discord Control Panel\n'];

      // Guilds section
      if (this.availableGuilds.length > 0) {
        parts.push(`\nServers (${this.availableGuilds.length}):`);
        this.availableGuilds.forEach((guild: any) => {
          const selected = guild.id === this.selectedGuildId ? ' [SELECTED]' : '';
          parts.push(`  • ${guild.name}${selected}`);
          parts.push(`    ID: ${guild.id}`);
          if (guild.memberCount) {
            parts.push(`    Members: ${guild.memberCount}`);
          }
        });
      } else {
        parts.push('\nNo servers available. Use listServers action.');
      }

      // Channels section
      if (this.selectedGuildId && this.availableChannels[this.selectedGuildId]) {
        const channels = this.availableChannels[this.selectedGuildId];
        parts.push(`\nChannels in selected server (${channels.length}):`);

        if (this.showCategories) {
          const categorized = this.categorizeChannels(channels);
          categorized.forEach((category: any) => {
            parts.push(`  📁 ${category.name}`);
            category.channels.forEach((channel: any) => {
              const joined = this.joinedChannels.has(channel.id) ? ' ✓' : '';
              parts.push(`    #${channel.name}${joined}`);
            });
          });
        } else {
          channels.forEach((channel: any) => {
            const joined = this.joinedChannels.has(channel.id) ? ' ✓' : '';
            parts.push(`  #${channel.name}${joined}`);
          });
        }
      }

      // Joined channels
      if (this.joinedChannels.size > 0) {
        parts.push(`\nCurrently joined (${this.joinedChannels.size}):`);
        this.joinedChannels.forEach((channelId: any) => {
          const channel = this.findChannel(channelId);
          if (channel) {
            parts.push(`  • ${channel.guildName}:#${channel.name}`);
          }
        });
      }

      return parts.join('\n');
    }

    private categorizeChannels(channels: ChannelInfo[]): CategoryInfo[] {
      const categories: Map<string, CategoryInfo> = new Map();
      const uncategorized: ChannelInfo[] = [];

      // Group by category
      channels.forEach((channel: any) => {
        if (channel.type === 4) { // Category channel
          categories.set(channel.id, {
            id: channel.id,
            name: channel.name,
            channels: []
          });
        }
      });

      // Add channels to categories
      channels.forEach((channel: any) => {
        if (channel.type === 0) { // Text channel
          if (channel.parentId && categories.has(channel.parentId)) {
            categories.get(channel.parentId)!.channels.push(channel);
          } else {
            uncategorized.push(channel);
          }
        }
      });

      // Sort channels within categories
      categories.forEach((category: any) => {
        category.channels.sort((a: any, b: any) => a.position - b.position);
      });

      // Build result
      const result = Array.from(categories.values());

      // Add uncategorized if any
      if (uncategorized.length > 0) {
        result.unshift({
          id: 'uncategorized',
          name: 'Text Channels',
          channels: uncategorized.sort((a: any, b: any) => a.position - b.position)
        });
      }

      return result;
    }

    private findChannel(channelId: string): ChannelInfo | undefined {
      for (const guildChannels of Object.values(this.availableChannels)) {
        const channel = guildChannels.find((c: any) => c.id === channelId);
        if (channel) return channel;
      }
      return undefined;
    }

    private findGuildByName(name: string): GuildInfo | undefined {
      return this.availableGuilds.find((g: any) =>
        g.name.toLowerCase() === name.toLowerCase()
      );
    }

    private findChannelByName(channelName: string, serverName: string): ChannelInfo | undefined {
      const guild = this.findGuildByName(serverName);
      if (!guild) return undefined;

      const channels = this.availableChannels[guild.id];
      if (!channels) return undefined;

      // Remove # prefix if present
      const cleanName = channelName.startsWith('#') ? channelName.slice(1) : channelName;

      return channels.find((c: any) =>
        c.type === 0 && c.name.toLowerCase() === cleanName.toLowerCase()
      );
    }

    private getSelectedServerName(): string | undefined {
      if (!this.selectedGuildId) return undefined;
      const guild = this.availableGuilds.find((g: any) => g.id === this.selectedGuildId);
      return guild?.name;
    }

    // ============================================
    // Discord Component Lookup
    // ============================================

    /**
     * Get Discord afferent component
     */
    private getDiscordAfferent(): any {
      const space = this.space;
      if (!space) {
        console.error('[DiscordControlPanel] No space found');
        return null;
      }

      // Find by capability (duck typing) or class name
      const afferent = space.components.find((c: any) => 
        c.constructor.name === 'DiscordAfferent' || 
        (typeof c.listGuilds === 'function' && typeof c.join === 'function')
      );

      if (afferent) {
        return afferent;
      }

      console.error('[DiscordControlPanel] Discord afferent not found in Space');
      return null;
    }

    private emitControlError(
      id: string,
      message: string,
      metadata: Record<string, any> = {}
    ): void {
      // Emit error event - will be transformed to facet by receptor
      this.emit({
        topic: 'discord:control-error',
        timestamp: Date.now(),
        payload: {
          errorId: id,
          message,
          severity: 'error',
          ...metadata
        }
      });

      // Activate agent so it sees the error
      this.reactivateAgent(`Error: ${message}`);
    }
  }

  // Import base components from connectome-ts
  const { ControlPanelActionsReceptor, PanelScopeReceptor, Component } = env;

  // ============================================
  // Discord Results Receptor (Unified) - FLEX Component
  // ============================================

  /**
   * Transforms all Discord result events into VEIL facets
   * FLEX Component with priority 100 (Receptor level)
   */
  class DiscordResultsReceptor extends Component {
    priority = 100;
    topics = ['discord:guilds-list', 'discord:channels-list', 'discord:channel-joined', 'discord:channel-left', 'discord:control-error', 'discord:message-sent'];

    execute(context: any): void {
      const { event } = context;
      if (!event || !this.topics.includes(event.topic)) return;

      const payload = event.payload;
      let deltas: any[] = [];

      switch (event.topic) {
        case 'discord:guilds-list':
          deltas = this.handleGuildsList(payload);
          break;
        case 'discord:channels-list':
          deltas = this.handleChannelsList(payload);
          break;
        case 'discord:channel-joined':
          deltas = this.handleChannelJoined(payload);
          break;
        case 'discord:channel-left':
          deltas = this.handleChannelLeft(payload);
          break;
        case 'discord:control-error':
          deltas = this.handleError(payload);
          break;
        case 'discord:message-sent':
          deltas = this.handleMessageSent(payload);
          break;
      }

      for (const delta of deltas) {
        (this as any).addOperation(delta);
      }
    }

    private handleGuildsList(payload: any): any[] {
      if (!payload?.guilds) {
        console.warn('[DiscordResultsReceptor] Invalid guilds payload:', payload);
        return [];
      }

      const parts: string[] = [];
      payload.guilds.forEach((guild: any) => {
        parts.push(`${guild.name}`);
        parts.push(`  ID: ${guild.id}`);
        if (guild.memberCount) parts.push(`  Members: ${guild.memberCount}`);
        parts.push('');
      });

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-result-guilds-${Date.now()}`,
          type: 'state',
          displayName: 'discord-guilds-list',
          content: parts.join('\n'),
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-result',
            resultType: 'guilds-list',
            guilds: payload.guilds,
            count: payload.guilds.length,
            timestamp: Date.now()
          }
        }
      }];
    }

    private handleChannelsList(payload: any): any[] {
      if (!payload?.channels || !payload?.guildId) {
        console.warn('[DiscordResultsReceptor] Invalid channels payload:', payload);
        return [];
      }

      const parts: string[] = [];
      const categories: Map<string, any> = new Map();
      const uncategorized: any[] = [];

      // Categorize channels
      payload.channels.forEach((channel: any) => {
        if (channel.type === 4) {
          categories.set(channel.id, { id: channel.id, name: channel.name, channels: [] });
        }
      });

      payload.channels.forEach((channel: any) => {
        if (channel.type === 0) {
          if (channel.parentId && categories.has(channel.parentId)) {
            categories.get(channel.parentId)!.channels.push(channel);
          } else {
            uncategorized.push(channel);
          }
        }
      });

      categories.forEach((cat: any) => {
        cat.channels.sort((a: any, b: any) => a.position - b.position);
      });

      const categorizedList = Array.from(categories.values());
      if (uncategorized.length > 0) {
        categorizedList.unshift({
          id: 'uncategorized',
          name: 'Text Channels',
          channels: uncategorized.sort((a: any, b: any) => a.position - b.position)
        });
      }

      // Format output
      categorizedList.forEach((cat: any) => {
        parts.push(`${cat.name}:`);
        cat.channels.forEach((ch: any) => {
          parts.push(`  #${ch.name}`);
          parts.push(`    ID: ${ch.id}`);
          if (ch.topic) parts.push(`    Topic: ${ch.topic}`);
        });
        parts.push('');
      });

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-result-channels-${payload.guildId}-${Date.now()}`,
          type: 'state',
          displayName: 'discord-channels-list',
          content: parts.join('\n'),
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-result',
            resultType: 'channels-list',
            guildId: payload.guildId,
            channels: payload.channels,
            count: payload.channels.length,
            timestamp: Date.now()
          }
        }
      }];
    }

    private handleChannelJoined(payload: any): any[] {
      if (!payload?.id) {
        console.warn('[DiscordResultsReceptor] Invalid channel joined payload:', payload);
        return [];
      }

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-joined-${payload.id}-${Date.now()}`,
          type: 'state',
          displayName: 'discord-channel-joined',
          content: `Joined ${payload.guildName}:#${payload.name}`,
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-result',
            resultType: 'channel-joined',
            channelId: payload.id,
            channelName: payload.name,
            guildName: payload.guildName,
            timestamp: Date.now(),
            ttl: 5000
          }
        }
      }];
    }

    private handleChannelLeft(payload: any): any[] {
      if (!payload?.channelId) {
        console.warn('[DiscordResultsReceptor] Invalid channel left payload:', payload);
        return [];
      }

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-left-${payload.channelId}-${Date.now()}`,
          type: 'state',
          displayName: 'discord-channel-left',
          content: `Left channel ${payload.channelId}`,
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-result',
            resultType: 'channel-left',
            channelId: payload.channelId,
            timestamp: Date.now(),
            ttl: 5000
          }
        }
      }];
    }

    private handleError(payload: any): any[] {
      if (!payload?.message) {
        console.warn('[DiscordResultsReceptor] Invalid error payload:', payload);
        return [];
      }

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-error-${payload.errorId || Date.now()}`,
          type: 'state',
          displayName: 'discord-control-error',
          content: `❌ ${payload.message}`,
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-error',
            severity: payload.severity || 'error',
            errorId: payload.errorId,
            message: payload.message,
            timestamp: Date.now(),
            ttl: payload.ttl || 10000  // Errors visible for 10 seconds by default
          }
        }
      }];
    }

    private handleMessageSent(payload: any): any[] {
      if (!payload?.channelId || !payload?.message) {
        console.warn('[DiscordResultsReceptor] Invalid message-sent payload:', payload);
        return [];
      }

      return [{
        type: 'addFacet',
        facet: {
          id: `discord-message-sent-${Date.now()}`,
          type: 'state',
          displayName: 'discord-message-sent',
          content: `✓ Message sent successfully`,
          scope: ['panel:discord-control'],
          state: {
            entityType: 'discord-result',
            resultType: 'message-sent',
            channelId: payload.channelId,
            message: payload.message,
            timestamp: Date.now(),
            ttl: 5000
          }
        }
      }];
    }
  }

  return {
    components: {
      DiscordControlPanelComponent,
      ControlPanelActionsReceptor,
      PanelScopeReceptor,
      DiscordResultsReceptor
    }
  };
}
