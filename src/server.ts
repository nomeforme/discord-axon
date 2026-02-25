#!/usr/bin/env npx tsx

/**
 * Combined Discord AXON Server
 * 
 * Includes both Discord bot connection AND module serving/transpilation
 */

import express from 'express';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  CommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionType,
  ComponentType
} from 'discord.js';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { AxonModuleServer } from '@connectome/axon-server';
import { join } from 'path';
import { loadConfig, DiscordConfig } from './config';
import { messageDeduplicator } from './message-deduplicator.js';

interface AxonConnection {
  ws: WebSocket;
  agentName: string;
  guildId: string;
  botId: string;  // Which bot this connection uses
  joinedChannels: Set<string>;
  lastRead: Map<string, string>;
  registeredCommands: Set<string>; // Track slash commands registered by this connection
  pendingInteractions: Map<string, any>; // Track interactions awaiting response
}

/**
 * Represents a single Discord bot client instance
 */
interface DiscordBotClient {
  id: string;           // Bot identifier (from config name)
  client: Client;       // Discord.js Client instance
  rest: REST;           // REST client for slash commands
  token: string;        // Bot token
  userId?: string;      // Discord user ID (after login)
  username?: string;    // Discord username
  displayName?: string; // Discord display name
}

/**
 * Bot configuration from config.json
 */
export interface BotConfig {
  name: string;
  token?: string;       // Bot token or env var reference (e.g., "$DISCORD_BOT_TOKEN")
  model?: string;
  prompt?: string;
  max_tokens?: number;
  persist_history?: boolean;
  tools?: string[];
  guild_id?: string | null;     // Optional guild binding
  auto_join_channels?: string[]; // Channels to auto-join
}

class CombinedDiscordAxonServer {
  private app = express();
  private wss: WebSocketServer;
  private bots = new Map<string, DiscordBotClient>();  // Map of botId -> DiscordBotClient
  private allBotUserIds = new Set<string>();  // Set of all bot Discord user IDs for deduplication
  private connections = new Map<string, AxonConnection>();
  private moduleServer: AxonModuleServer;
  private hotReloadWss?: WebSocketServer;

  constructor(
    private httpPort: number = 8080,
    private wsPort: number = 8081,
    private modulePort: number = 8082
  ) {
    // WebSocket server for AXON connections
    this.wss = new WebSocketServer({ port: wsPort });

    // Create module server
    this.moduleServer = new AxonModuleServer({
      port: this.modulePort,
      hotReload: true,
      corsOrigin: '*'
    });

    // Routes and services setup
    this.setupRoutes();
    this.setupWebSocket();
  }

  /**
   * Resolve a token value - handles env var references like "$DISCORD_BOT_TOKEN"
   */
  private resolveToken(tokenValue?: string): string | undefined {
    if (!tokenValue) return undefined;

    if (tokenValue.startsWith('$')) {
      const envVar = tokenValue.slice(1);
      return process.env[envVar];
    }

    return tokenValue;
  }

  /**
   * Initialize all bots from configuration
   */
  async initBots(botConfigs: BotConfig[]): Promise<void> {
    for (const config of botConfigs) {
      const token = this.resolveToken(config.token);
      if (!token) {
        console.warn(`[Server] No token for bot ${config.name}, skipping`);
        continue;
      }

      console.log(`[Server] Initializing bot: ${config.name}`);

      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers
        ]
      });

      // Login to Discord
      await client.login(token);

      // Wait for client to be ready
      await new Promise<void>(resolve => {
        if (client.isReady()) resolve();
        else client.once('ready', () => resolve());
      });

      const rest = new REST({ version: '10' }).setToken(token);

      const botClient: DiscordBotClient = {
        id: config.name,
        client,
        rest,
        token,
        userId: client.user?.id,
        username: client.user?.username,
        displayName: client.user?.displayName || client.user?.username
      };

      this.bots.set(config.name, botClient);
      this.setupBotEventHandlers(botClient);

      // Add bot name -> Discord ID mapping for mention resolution
      // This allows bots to mention each other using config names (e.g., <@claude-opus-4-5>)
      if (client.user?.id) {
        // Track all bot user IDs for message deduplication
        this.allBotUserIds.add(client.user.id);
        // Map config name (agentName) to Discord ID
        this.userNameToId.set(config.name.toLowerCase(), client.user.id);
        // Also map Discord username (which may have special chars) to Discord ID
        if (client.user.username) {
          this.userNameToId.set(client.user.username.toLowerCase(), client.user.id);
        }
        console.log(`[Server] Mapped bot mentions: ${config.name} -> ${client.user.id}`);
      }

      console.log(`[Server] Bot ${config.name} logged in as ${client.user?.tag} (ID: ${client.user?.id})`);
    }

    console.log(`[Server] Initialized ${this.bots.size} bot(s)`);
  }

  /**
   * Get a bot by ID
   */
  getBot(botId: string): DiscordBotClient | undefined {
    return this.bots.get(botId);
  }

  /**
   * Get all bot IDs
   */
  getBotIds(): string[] {
    return Array.from(this.bots.keys());
  }
  
  private async registerDiscordModules(): Promise<void> {
    // Determine if running from compiled dist/ or source src/
    // Check if current file ends with .ts (dev/ts-node) or .js (compiled)
    const isCompiledContext = import.meta.filename.endsWith('.js') && import.meta.dirname.includes('/dist');
    const isDevelopment = import.meta.filename.endsWith('.ts') || !import.meta.dirname.includes('/dist');

    const modulesDir = isCompiledContext
      ? join(import.meta.dirname, '..', 'src', 'modules')  // dist/ -> ../src/modules
      : join(import.meta.dirname, 'modules');              // src/ -> modules (when running from src/)

    console.log(`[Server] Module registration - isDev: ${isDevelopment}, modulesDir: ${modulesDir}`);
    
    // Register the new Discord Afferent
    await this.moduleServer.addModule('discord-afferent', {
      name: 'discord-afferent',
      path: join(modulesDir, 'discord-afferent.ts'),
      manifest: {
        name: 'DiscordAfferent',
        version: '2.0.0',
        description: 'Discord WebSocket afferent for RETM architecture',
        componentClass: 'DiscordAfferent',
        moduleType: 'function',
        exports: {
          afferents: ['DiscordAfferent']
        },
        actions: {
          'join': {
            description: 'Join a Discord channel',
            parameters: { channelId: { type: 'string', required: true } }
          },
          'leave': {
            description: 'Leave a Discord channel',
            parameters: { channelId: { type: 'string', required: true } }
          },
          'send': {
            description: 'Send a message to a channel',
            parameters: { 
              channelId: { type: 'string', required: true },
              message: { type: 'string', required: true }
            }
          }
        }
      }
    });
    
    await this.moduleServer.addModule('discord-control-panel', {
      name: 'discord-control-panel',
      path: join(modulesDir, 'discord-control-panel.ts'),
      manifest: {
        name: 'DiscordControlPanelComponent',
        version: '1.0.0',
        description: 'Discord server and channel management UI',
        componentClass: 'DiscordControlPanelComponent',
        moduleType: 'function',
        actions: {
          'listServers': {
            description: 'List all Discord servers',
            parameters: {}
          },
          'selectServer': {
            description: 'Select a server',
            parameters: { serverName: { type: 'string', required: true } }
          },
          'listChannels': {
            description: 'List channels in a server',
            parameters: { serverName: { type: 'string', required: false } }
          },
          'joinChannel': {
            description: 'Join a channel',
            parameters: { 
              channelName: { type: 'string', required: true },
              serverName: { type: 'string', required: false }
            }
          },
          'leaveChannel': {
            description: 'Leave a channel',
            parameters: {
              channelName: { type: 'string', required: true },
              serverName: { type: 'string', required: false }
            }
          },
          'showJoinedChannels': {
            description: 'Show all joined channels',
            parameters: {}
          }
        }
      }
    });
    
    // Register component-factory module
    await this.moduleServer.addModule('component-factory', {
      name: 'component-factory',
      path: join(modulesDir, 'component-factory.ts'),
      manifest: {
        name: 'ComponentFactoryComponent',
        version: '1.0.0',
        description: 'Dynamic component creation control panel',
        componentClass: 'ComponentFactoryComponent',
        moduleType: 'function',
        exports: {
          receptors: ['ComponentFactoryActionsReceptor']
        },
        actions: {
          'createComponent': {
            description: 'Create a new component with custom configuration',
            parameters: {
              componentId: { type: 'string', required: false },
              componentType: { type: 'string', required: true },
              config: { type: 'object', required: false }
            }
          },
          'createBox': {
            description: 'Create a new box agent with the given name',
            parameters: {
              boxName: { type: 'string', required: true }
            }
          }
        }
      }
    });
  }
  
  private setupRoutes() {
    // Mount the module server routes
    this.app.use('/modules', this.moduleServer.getRouter() as any);

    // Health check
    this.app.get('/health', (req, res) => {
      const botStatuses: Record<string, any> = {};
      for (const [id, bot] of this.bots) {
        botStatuses[id] = {
          connected: bot.client.isReady(),
          userId: bot.userId,
          username: bot.username
        };
      }

      res.json({
        status: 'ok',
        bots: botStatuses,
        botCount: this.bots.size,
        connections: this.connections.size,
        modules: 'available at /modules/manifest'
      });
    });

    // List available bots
    this.app.get('/bots', (req, res) => {
      const botList = Array.from(this.bots.entries()).map(([id, bot]) => ({
        id,
        userId: bot.userId,
        username: bot.username,
        displayName: bot.displayName,
        connected: bot.client.isReady()
      }));
      res.json({ bots: botList });
    });

    // Root info
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Combined Discord AXON Server',
        version: '2.0.0',
        features: ['multi-bot'],
        endpoints: {
          modules: '/modules/manifest',
          health: '/health',
          bots: '/bots',
          websocket: `ws://localhost:${this.wsPort}/ws`
        }
      });
    });
  }
  
  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url!, `http://localhost:${this.httpPort}`);
      const path = url.pathname;
      
      if (path !== '/ws') {
        ws.close(1002, 'Invalid path');
        return;
      }
      
      console.log('[Server] New WebSocket connection');
      
      // Wait for auth message
      ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'auth') {
            await this.handleAuth(ws, msg);
          } else {
            const connectionId = this.findConnectionId(ws);
            if (connectionId) {
              await this.handleAxonMessage(connectionId, msg);
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Not authenticated'
              }));
            }
          }
        } catch (error: any) {
          console.error('[Server] Message handling error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            error: error.message
          }));
        }
      });
      
      ws.on('close', async () => {
        const connectionId = this.findConnectionId(ws);
        if (connectionId) {
          console.log(`[Server] Connection closed: ${connectionId}`);

          // Clean up registered slash commands
          const connection = this.connections.get(connectionId);
          if (connection && connection.registeredCommands.size > 0) {
            const bot = this.bots.get(connection.botId);
            if (bot) {
              console.log(`[Server] [${bot.id}] Cleaning up ${connection.registeredCommands.size} slash commands`);
              for (const commandName of connection.registeredCommands) {
                await this.unregisterSlashCommand(bot, connection.guildId, commandName);
              }
            }
          }

          this.connections.delete(connectionId);
        }
      });
      
      ws.on('error', (error: Error) => {
        console.error('[Server] WebSocket error:', error);
      });
    });
  }
  
  private findConnectionId(ws: WebSocket): string | undefined {
    for (const [id, conn] of this.connections) {
      if (conn.ws === ws) return id;
    }
    return undefined;
  }
  
  private async handleAuth(ws: WebSocket, msg: any): Promise<void> {
    const { token, guild, agent, botId } = msg;

    console.log(`[Server] Auth request from agent: ${agent}, guild: ${guild}, botId: ${botId}`);

    // Find the requested bot
    let bot: DiscordBotClient | undefined;

    if (botId) {
      bot = this.bots.get(botId);
      if (!bot) {
        const availableBots = Array.from(this.bots.keys()).join(', ');
        ws.send(JSON.stringify({
          type: 'error',
          error: `Bot '${botId}' not found. Available bots: ${availableBots || 'none'}`
        }));
        ws.close();
        return;
      }
    } else {
      // Backwards compatibility: use first available bot if no botId specified
      bot = this.bots.values().next().value;
      if (!bot) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'No bots available. Please configure at least one bot with a valid token.'
        }));
        ws.close();
        return;
      }
      console.log(`[Server] No botId specified, using default bot: ${bot.id}`);
    }

    // Create connection bound to specific bot
    const connectionId = this.generateConnectionId();
    const connection: AxonConnection = {
      ws,
      agentName: agent || 'Agent',
      guildId: guild || '',
      botId: bot.id,
      joinedChannels: new Set(),
      lastRead: new Map(),
      registeredCommands: new Set(),
      pendingInteractions: new Map()
    };

    this.connections.set(connectionId, connection);

    // Send success with THIS BOT's info
    ws.send(JSON.stringify({
      type: 'authenticated',
      connectionId,
      botId: bot.id,
      botUserId: bot.userId,
      botUsername: bot.username,
      botDisplayName: bot.displayName
    }));

    console.log(`[Server] Authenticated connection: ${connectionId} using bot: ${bot.id}`);
  }
  
  // Cache for reverse mention lookups (name -> ID)
  private userNameToId = new Map<string, string>();
  private channelNameToId = new Map<string, string>();
  private roleNameToId = new Map<string, string>();

  /**
   * Parse Discord mentions and replace them with human-readable text
   * Returns both parsed content and mention metadata
   */
  private parseMentions(message: any): { content: string; mentions: any } {
    let content = message.content;
    const mentions: any = {
      users: [],
      channels: [],
      roles: []
    };

    // DEBUG: Log raw mentions from Discord.js
    console.log(`[Server:parseMentions] Raw message.mentions.users size: ${message.mentions?.users?.size ?? 'undefined'}`);
    if (message.mentions?.users) {
      message.mentions.users.forEach((user: any) => {
        console.log(`[Server:parseMentions] Found mention: ${user.username} (${user.id}), bot=${user.bot}`);
      });
    }

    // Parse user mentions
    if (message.mentions?.users?.size > 0) {
      message.mentions.users.forEach((user: any) => {
        const mentionPattern = new RegExp(`<@!?${user.id}>`, 'g');
        content = content.replace(mentionPattern, `<@${user.username}>`);
        mentions.users.push({
          id: user.id,
          username: user.username,
          displayName: user.displayName || user.username,
          bot: user.bot || false
        });
        
        // Cache for reverse lookup
        this.userNameToId.set(user.username.toLowerCase(), user.id);
      });
    }

    // Parse channel mentions
    if (message.mentions?.channels?.size > 0) {
      message.mentions.channels.forEach((channel: any) => {
        const mentionPattern = new RegExp(`<#${channel.id}>`, 'g');
        content = content.replace(mentionPattern, `<#${channel.name}>`);
        mentions.channels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type
        });
        
        // Cache for reverse lookup
        this.channelNameToId.set(channel.name.toLowerCase(), channel.id);
      });
    }

    // Parse role mentions
    if (message.mentions?.roles?.size > 0) {
      message.mentions.roles.forEach((role: any) => {
        const mentionPattern = new RegExp(`<@&${role.id}>`, 'g');
        content = content.replace(mentionPattern, `<@${role.name}>`);
        mentions.roles.push({
          id: role.id,
          name: role.name,
          color: role.color
        });
        
        // Cache for reverse lookup
        this.roleNameToId.set(role.name.toLowerCase(), role.id);
      });
    }

    return { content, mentions };
  }

  /**
   * Convert human-readable mentions back to Discord IDs for sending
   * Transforms: <@username> -> <@USER_ID>
   *            <#channelname> -> <#CHANNEL_ID>
   *            <@rolename> -> <@&ROLE_ID>
   */
  private async unparseMentions(content: string, guildId?: string, bot?: DiscordBotClient): Promise<string> {
    let result = content;

    // Use provided bot or fall back to first available bot
    const discordClient = bot?.client || this.bots.values().next().value?.client;
    if (!discordClient) {
      console.warn('[Server] No Discord client available for mention resolution');
      return result;
    }

    // Collect all replacements to do at once (to avoid conflicts)
    const replacements: Array<{ from: string; to: string }> = [];

    // Find all channel mentions: <#channelname>
    const channelMentionPattern = /<#([^\s<>@#&!]+)>/gu;
    const channelMatches = [...content.matchAll(channelMentionPattern)];

    for (const match of channelMatches) {
      const channelName = match[1];
      const channelNameLower = channelName.toLowerCase();

      // Try cache first
      let channelId = this.channelNameToId.get(channelNameLower);

      // If not in cache, try to find in Discord
      if (!channelId && guildId) {
        try {
          const guild = await discordClient.guilds.fetch(guildId);
          const channel = guild.channels.cache.find(c =>
            c.name.toLowerCase() === channelNameLower
          );
          if (channel) {
            channelId = channel.id;
            this.channelNameToId.set(channelNameLower, channelId);
          }
        } catch (error) {
          console.warn(`[Server] Could not resolve channel mention: ${channelName}`);
        }
      }

      if (channelId) {
        replacements.push({ from: `<#${channelName}>`, to: `<#${channelId}>` });
      }
    }

    // Find all @ mentions (users or roles): <@name>
    // Use Unicode-aware pattern to match non-ASCII usernames (Cyrillic, etc.)
    const atMentionPattern = /<@([^\s<>@#&!]+)>/gu;
    const atMatches = [...content.matchAll(atMentionPattern)];

    for (const match of atMatches) {
      const name = match[1];
      const nameLower = name.toLowerCase();

      // Try as user first
      let userId = this.userNameToId.get(nameLower);

      if (userId) {
        // Convert to proper Discord mention format (including self-mentions)
        // Self-mention response prevention is handled by messageCreate check (line 819)
        replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
        console.log(`[Server:unparseMentions] Resolved <@${name}> -> <@${userId}>`);
        continue;
      }

      // Try as role
      let roleId = this.roleNameToId.get(nameLower);

      if (roleId) {
        replacements.push({ from: `<@${name}>`, to: `<@&${roleId}>` });
        continue;
      }

      // If not in cache, try to find in Discord
      if (guildId) {
        try {
          const guild = await discordClient.guilds.fetch(guildId);

          // Try to find as user - search by username
          try {
            const members = await guild.members.search({ query: name, limit: 10 });
            const member = members.find(m =>
              m.user.username.toLowerCase() === nameLower
            );
            if (member) {
              userId = member.user.id;
              this.userNameToId.set(nameLower, userId);
              replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
              console.log(`[Server] Resolved mention <@${name}> -> <@${userId}> via Discord API`);
              continue;
            }
          } catch (searchError) {
            // Search failed, try fetching all members
            console.log(`[Server] Member search failed for ${name}, trying full fetch`);
            const members = await guild.members.fetch({ limit: 1000 });
            const member = members.find(m =>
              m.user.username.toLowerCase() === nameLower
            );
            if (member) {
              userId = member.user.id;
              this.userNameToId.set(nameLower, userId);
              replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
              console.log(`[Server] Resolved mention <@${name}> -> <@${userId}> via full member fetch`);
              continue;
            }
          }

          // Try to find as role
          const role = guild.roles.cache.find(r =>
            r.name.toLowerCase() === nameLower
          );
          if (role) {
            roleId = role.id;
            this.roleNameToId.set(nameLower, roleId);
            replacements.push({ from: `<@${name}>`, to: `<@&${roleId}>` });
            continue;
          }

          console.warn(`[Server] Could not resolve mention: ${name}`);
        } catch (error) {
          console.warn(`[Server] Error resolving mention ${name}:`, error);
        }
      }
    }

    // Apply all replacements
    for (const { from, to } of replacements) {
      result = result.replace(from, to);
    }

    return result;
  }

  /**
   * Set up event handlers for a specific bot
   */
  private setupBotEventHandlers(bot: DiscordBotClient): void {
    bot.client.on('ready', () => {
      console.log(`[Discord] Bot ${bot.id} logged in as ${bot.client.user?.tag}`);
      console.log(`[Discord] Bot ${bot.id} ID: ${bot.client.user?.id}`);
    });

    // Handle slash commands and button interactions
    bot.client.on('interactionCreate', async (interaction) => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        console.log(`[Discord] [${bot.id}] Slash command received: /${interaction.commandName}`);

        // Find connections using THIS bot that should handle this interaction
        for (const [id, connection] of this.connections) {
          if (connection.botId === bot.id &&
              interaction.guildId && interaction.guildId === connection.guildId) {
            // Store interaction for potential response
            connection.pendingInteractions.set(interaction.id, interaction);

            // Forward to AXON client
            connection.ws.send(JSON.stringify({
              type: 'interaction:slash-command',
              botId: bot.id,
              payload: {
                interactionId: interaction.id,
                commandName: interaction.commandName,
                options: interaction.options.data.map((opt: any) => ({
                  name: opt.name,
                  type: opt.type,
                  value: opt.value
                })),
                user: interaction.user.username,
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId
              }
            }));

            console.log(`[Discord] [${bot.id}] Forwarded slash command to connection: ${id}`);
            break;
          }
        }
      }

      // Handle button interactions
      else if (interaction.isButton()) {
        console.log(`[Discord] [${bot.id}] Button interaction: ${interaction.customId}`);

        // Find connections using THIS bot that should handle this interaction
        for (const [id, connection] of this.connections) {
          if (connection.botId === bot.id &&
              interaction.guildId && interaction.guildId === connection.guildId) {
            // Store interaction for potential response
            connection.pendingInteractions.set(interaction.id, interaction);

            // Forward to AXON client
            connection.ws.send(JSON.stringify({
              type: 'interaction:button',
              botId: bot.id,
              payload: {
                interactionId: interaction.id,
                customId: interaction.customId,
                user: interaction.user.username,
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId,
                messageId: interaction.message.id
              }
            }));

            console.log(`[Discord] [${bot.id}] Forwarded button interaction to connection: ${id}`);
            break;
          }
        }
      }
    });

    bot.client.on('messageCreate', async (message) => {
      // Skip messages from ANY of our bots to prevent loops and duplicate facets
      if (this.allBotUserIds.has(message.author.id)) return;

      // Deduplicate across multiple bots - only first bot to receive should forward
      // This prevents N bots from creating N facets for the same message
      if (!messageDeduplicator.shouldEmit(message.id, bot.id)) {
        return; // Another bot already forwarded this message
      }

      // Cache the message author for reverse lookups (so bot can mention them back)
      this.userNameToId.set(message.author.username.toLowerCase(), message.author.id);

      // Parse mentions
      const { content, mentions } = this.parseMentions(message);

      // Extract reply information
      let replyInfo = null;
      if (message.reference && message.reference.messageId) {
        // Try to get the referenced message from cache
        const referencedMessage = message.channel.messages.cache.get(message.reference.messageId);
        replyInfo = {
          messageId: message.reference.messageId,
          author: referencedMessage?.author.username,
          authorId: referencedMessage?.author.id
        };
        console.log(`[Server] [${bot.id}] Reply detected: user ${message.author.username} replying to message ${message.reference.messageId} (author: ${replyInfo.authorId})`);
      }

      // Extract attachments
      const attachments = message.attachments.map(a => ({
        id: a.id,
        url: a.url,
        proxyUrl: a.proxyURL,
        contentType: a.contentType,
        name: a.name,
        description: a.description,
        size: a.size,
        height: a.height,
        width: a.width
      }));

      // Forward to connections using THIS bot that have joined this channel
      for (const [id, connection] of this.connections) {
        if (connection.botId === bot.id &&
            connection.joinedChannels.has(message.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'message',
            botId: bot.id,
            payload: {
              channelId: message.channelId,
              messageId: message.id,
              author: message.author.username,
              authorId: message.author.id,
              isBot: message.author.bot,
              content: content, // Parsed content with human-readable mentions
              rawContent: message.content, // Original content with Discord IDs
              mentions: mentions, // Structured mention metadata
              attachments: attachments, // Attachments
              reply: replyInfo, // Reply information if this is a reply
              timestamp: message.createdAt.toISOString(),
              guildId: message.guildId,
              guildName: message.guild?.name,
              channelName: (message.channel as TextChannel).name
            }
          }));

          // Update last read
          connection.lastRead.set(message.channelId, message.id);
        }
      }
    });

    // Handle message edits
    bot.client.on('messageUpdate', async (oldMessage, newMessage) => {
      // Skip edits from ANY of our bots
      if (newMessage.author?.id && this.allBotUserIds.has(newMessage.author.id)) return;

      // Deduplicate across multiple bots
      if (!messageDeduplicator.shouldEmit(`edit:${newMessage.id}`, bot.id)) {
        return;
      }

      // Parse mentions for both old and new content
      const oldParsed = oldMessage.content ? this.parseMentions(oldMessage) : { content: '', mentions: null };
      const newParsed = newMessage.content ? this.parseMentions(newMessage) : { content: '', mentions: null };

      for (const [id, connection] of this.connections) {
        if (connection.botId === bot.id &&
            connection.joinedChannels.has(newMessage.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'messageUpdate',
            botId: bot.id,
            payload: {
              channelId: newMessage.channelId,
              messageId: newMessage.id,
              author: newMessage.author?.username,
              authorId: newMessage.author?.id,
              isBot: newMessage.author?.bot || false,
              content: newParsed.content, // Parsed new content
              rawContent: newMessage.content, // Original new content
              oldContent: oldParsed.content, // Parsed old content
              rawOldContent: oldMessage.content, // Original old content
              mentions: newParsed.mentions, // Mention metadata
              timestamp: newMessage.editedAt?.toISOString() || newMessage.createdAt?.toISOString(),
              guildId: newMessage.guildId,
              guildName: newMessage.guild?.name,
              channelName: (newMessage.channel as TextChannel).name
            }
          }));
        }
      }
    });

    // Handle message deletes
    bot.client.on('messageDelete', async (message) => {
      // Skip deletes from ANY of our bots
      if (message.author?.id && this.allBotUserIds.has(message.author.id)) return;

      // Deduplicate across multiple bots
      if (!messageDeduplicator.shouldEmit(`delete:${message.id}`, bot.id)) {
        return;
      }

      // Forward to connections using THIS bot that have joined this channel
      for (const [id, connection] of this.connections) {
        if (connection.botId === bot.id &&
            connection.joinedChannels.has(message.channelId)) {
          connection.ws.send(JSON.stringify({
            type: 'messageDelete',
            botId: bot.id,
            payload: {
              channelId: message.channelId,
              messageId: message.id,
              author: message.author?.username,
              authorId: message.author?.id,
              isBot: message.author?.bot || false,
              timestamp: new Date().toISOString(),
              guildId: message.guildId,
              guildName: message.guild?.name,
              channelName: (message.channel as TextChannel).name
            }
          }));
        }
      }
    });
  }
  
  private async handleAxonMessage(connectionId: string, msg: any): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    console.log(`[Server] Handling message:`, msg.type);
    
    switch (msg.type) {
      case 'join': {
        const { channelId, scrollback = 50, lastMessageId } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const channel = await bot.client.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          connection.joinedChannels.add(channelId);

          // Cache channel name for reverse lookups
          this.channelNameToId.set(channel.name.toLowerCase(), channel.id);

          // Cache guild members for reverse user lookups
          if (channel.guild) {
            const members = await channel.guild.members.fetch({ limit: 100 });
            members.forEach(member => {
              this.userNameToId.set(member.user.username.toLowerCase(), member.user.id);
            });

            // Cache roles for reverse role lookups
            channel.guild.roles.cache.forEach(role => {
              this.roleNameToId.set(role.name.toLowerCase(), role.id);
            });
          }

          // Get messages after lastMessageId if provided, otherwise get recent messages
          const messages = await channel.messages.fetch({
            limit: scrollback,
            ...(lastMessageId ? { after: lastMessageId } : {})
          });

          // Send history
          // Note: messages.reverse() is only needed when fetching with 'before'
          // With 'after', messages are already in chronological order
          const orderedMessages = lastMessageId ? messages : messages.reverse();

          connection.ws.send(JSON.stringify({
            type: 'history',
            botId: bot.id,
            channelId: channel.id,
            channelName: channel.name,
            guildId: channel.guildId,
            guildName: channel.guild?.name,
            messages: orderedMessages.map(m => {
              const { content, mentions } = this.parseMentions(m);
              return {
                channelId: m.channelId,
                messageId: m.id,
                author: m.author.username,
                authorId: m.author.id,
                isBot: m.author.bot,
                content: content, // Parsed content with human-readable mentions
                rawContent: m.content, // Original content with Discord IDs
                mentions: mentions, // Structured mention metadata
                timestamp: m.createdAt.toISOString()
              };
            })
          }));

          // Send joined confirmation with channel info
          connection.ws.send(JSON.stringify({
            type: 'joined',
            botId: bot.id,
            channel: {
              id: channel.id,
              name: channel.name,
              type: channel.type,
              guildId: channel.guildId,
              guildName: channel.guild?.name
            }
          }));

          console.log(`[Server] [${bot.id}] Agent joined channel: ${channel.name} (${channelId})`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to join channel:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to join channel: ${error.message}`
          }));
        }
        break;
      }
      
      case 'leave': {
        const { channelId } = msg;
        connection.joinedChannels.delete(channelId);
        
        // Send left confirmation
        connection.ws.send(JSON.stringify({
          type: 'left',
          channelId
        }));
        
        console.log(`[Server] Agent left channel: ${channelId}`);
        break;
      }
      
      case 'send': {
        const { channelId, message } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const channel = await bot.client.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          // Convert human-readable mentions to Discord IDs
          const discordMessage = await this.unparseMentions(message, channel.guildId, bot);

          // Split message into chunks if too long for Discord (2000 char limit)
          const chunks = this.splitMessage(discordMessage);
          let lastSentMessage: any = null;

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            lastSentMessage = await channel.send(chunk);
            if (chunks.length > 1) {
              console.log(`[Server] [${bot.id}] Sent chunk ${i + 1}/${chunks.length} to ${channel.name} (ID: ${lastSentMessage.id})`);
            } else {
              console.log(`[Server] [${bot.id}] Sent message to ${channel.name}: ${message.substring(0, 50)}... (ID: ${lastSentMessage.id})`);
            }
          }

          // Send confirmation back to client with last message ID
          connection.ws.send(JSON.stringify({
            type: 'message_sent',
            botId: bot.id,
            channelId: channelId,
            messageId: lastSentMessage?.id,
            content: message,
            chunks: chunks.length,
            timestamp: lastSentMessage?.createdAt?.toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to send message:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send message: ${error.message}`
          }));
        }
        break;
      }
      
      case 'listGuilds': {
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const guilds = bot.client.guilds.cache.map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            memberCount: guild.memberCount
          }));

          connection.ws.send(JSON.stringify({
            type: 'guilds',
            botId: bot.id,
            guilds
          }));

          console.log(`[Server] [${bot.id}] Sent guilds list to ${connection.agentName} (${guilds.length} guilds)`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to list guilds:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to list guilds: ${error.message}`
          }));
        }
        break;
      }

      case 'listChannels': {
        const { guildId } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const guild = await bot.client.guilds.fetch(guildId);
          if (!guild) {
            throw new Error('Guild not found');
          }

          const channels = guild.channels.cache
            .filter(channel => channel.isTextBased())
            .map(channel => ({
              id: channel.id,
              name: channel.name,
              type: channel.type,
              guildId: guild.id,
              guildName: guild.name,
              parentId: channel.parentId,
              position: 'position' in channel ? channel.position : 0
            }))
            .sort((a, b) => a.position - b.position);

          connection.ws.send(JSON.stringify({
            type: 'channels',
            botId: bot.id,
            guildId,
            channels
          }));

          console.log(`[Server] [${bot.id}] Sent channels list for guild ${guild.name} to ${connection.agentName} (${channels.length} channels)`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to list channels:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to list channels: ${error.message}`
          }));
        }
        break;
      }

      case 'registerSlashCommand': {
        const { name, description, options = [] } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          // Wait for Discord to be ready
          if (!bot.client.isReady()) {
            console.log(`[Server] [${bot.id}] Waiting for Discord to be ready before registering /${name}...`);
            await new Promise<void>((resolve) => {
              if (bot.client.isReady()) {
                resolve();
              } else {
                bot.client.once('ready', () => resolve());
              }
            });
          }

          await this.registerSlashCommand(bot, connection.guildId, name, description, options);
          connection.registeredCommands.add(name);

          connection.ws.send(JSON.stringify({
            type: 'slash-command-registered',
            botId: bot.id,
            name
          }));

          console.log(`[Server] [${bot.id}] Registered slash command /${name} for ${connection.agentName}`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to register slash command:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to register slash command: ${error.message}`
          }));
        }
        break;
      }

      case 'unregisterSlashCommand': {
        const { name } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          await this.unregisterSlashCommand(bot, connection.guildId, name);
          connection.registeredCommands.delete(name);

          connection.ws.send(JSON.stringify({
            type: 'slash-command-unregistered',
            botId: bot.id,
            name
          }));

          console.log(`[Server] [${bot.id}] Unregistered slash command /${name} for ${connection.agentName}`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to unregister slash command:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to unregister slash command: ${error.message}`
          }));
        }
        break;
      }

      case 'sendTyping': {
        const { channelId } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const channel = await bot.client.channels.fetch(channelId) as TextChannel;
          if (!channel || !channel.isTextBased()) {
            throw new Error('Channel not found or not a text channel');
          }

          await channel.sendTyping();
          console.log(`[Server] [${bot.id}] Sent typing indicator to ${channel.name}`);
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to send typing indicator:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send typing indicator: ${error.message}`
          }));
        }
        break;
      }

      case 'sendEmbed': {
        const { channelId, embed, buttons = [] } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const channel = await bot.client.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          // Build embed
          const embedBuilder = new EmbedBuilder()
            .setTitle(embed.title)
            .setDescription(embed.description)
            .setColor(embed.color || 0x5865F2);

          if (embed.fields) {
            embedBuilder.addFields(embed.fields);
          }

          // Build message payload
          const messagePayload: any = { embeds: [embedBuilder] };

          // Add buttons if provided
          if (buttons.length > 0) {
            const row = new ActionRowBuilder<ButtonBuilder>();
            for (const btn of buttons) {
              const button = new ButtonBuilder()
                .setCustomId(btn.customId)
                .setLabel(btn.label)
                .setStyle(this.getButtonStyle(btn.style));

              if (btn.emoji) {
                button.setEmoji(btn.emoji);
              }

              row.addComponents(button);
            }
            messagePayload.components = [row];
          }

          const sentMessage = await channel.send(messagePayload);
          console.log(`[Server] [${bot.id}] Sent embed to ${channel.name} with ${buttons.length} buttons`);

          // Send confirmation
          connection.ws.send(JSON.stringify({
            type: 'message_sent',
            botId: bot.id,
            channelId,
            messageId: sentMessage.id,
            timestamp: sentMessage.createdAt.toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to send embed:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to send embed: ${error.message}`
          }));
        }
        break;
      }

      case 'editMessage': {
        const { channelId, messageId, content, embed, buttons = [] } = msg;
        const bot = this.bots.get(connection.botId);

        if (!bot) {
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Bot ${connection.botId} not found`
          }));
          break;
        }

        try {
          const channel = await bot.client.channels.fetch(channelId) as TextChannel;
          if (!channel || channel.type !== 0) {
            throw new Error('Channel not found or not a text channel');
          }

          const message = await channel.messages.fetch(messageId);
          if (!message) {
            throw new Error('Message not found');
          }

          // Build message payload
          const messagePayload: any = {};

          if (content !== undefined) {
            messagePayload.content = content;
          }

          if (embed) {
            const embedBuilder = new EmbedBuilder()
              .setTitle(embed.title)
              .setDescription(embed.description)
              .setColor(embed.color || 0x5865F2);

            if (embed.fields) {
              embedBuilder.addFields(embed.fields);
            }

            messagePayload.embeds = [embedBuilder];
          }

          // Add buttons if provided
          if (buttons.length > 0) {
            const row = new ActionRowBuilder<ButtonBuilder>();
            for (const btn of buttons) {
              const button = new ButtonBuilder()
                .setCustomId(btn.customId)
                .setLabel(btn.label)
                .setStyle(this.getButtonStyle(btn.style));

              if (btn.emoji) {
                button.setEmoji(btn.emoji);
              }

              row.addComponents(button);
            }
            messagePayload.components = [row];
          } else {
            // Clear buttons if none provided
            messagePayload.components = [];
          }

          await message.edit(messagePayload);
          console.log(`[Server] [${bot.id}] Edited message ${messageId} in ${channel.name}`);

          // Send confirmation
          connection.ws.send(JSON.stringify({
            type: 'message_edited',
            botId: bot.id,
            channelId,
            messageId,
            timestamp: new Date().toISOString()
          }));
        } catch (error: any) {
          console.error(`[Server] [${connection.botId}] Failed to edit message:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to edit message: ${error.message}`
          }));
        }
        break;
      }

      case 'replyToInteraction': {
        const { interactionId, content, embed, ephemeral = false } = msg;

        try {
          const interaction = connection.pendingInteractions.get(interactionId);
          if (!interaction) {
            throw new Error('Interaction not found or expired');
          }

          const replyOptions: any = { ephemeral };

          if (content) {
            replyOptions.content = content;
          }

          if (embed) {
            const embedBuilder = new EmbedBuilder()
              .setTitle(embed.title)
              .setDescription(embed.description)
              .setColor(embed.color || 0x5865F2);

            if (embed.fields) {
              embedBuilder.addFields(embed.fields);
            }

            replyOptions.embeds = [embedBuilder];
          }

          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(replyOptions);
          } else {
            await interaction.reply(replyOptions);
          }

          // Clean up
          connection.pendingInteractions.delete(interactionId);

          console.log(`[Server] Replied to interaction ${interactionId}`);
        } catch (error: any) {
          console.error(`[Server] Failed to reply to interaction:`, error);
          connection.ws.send(JSON.stringify({
            type: 'error',
            error: `Failed to reply to interaction: ${error.message}`
          }));
        }
        break;
      }
    }
  }

  private getButtonStyle(style: string): ButtonStyle {
    switch (style.toLowerCase()) {
      case 'primary':
      case 'blurple':
        return ButtonStyle.Primary;
      case 'secondary':
      case 'grey':
      case 'gray':
        return ButtonStyle.Secondary;
      case 'success':
      case 'green':
        return ButtonStyle.Success;
      case 'danger':
      case 'red':
        return ButtonStyle.Danger;
      case 'link':
        return ButtonStyle.Link;
      default:
        return ButtonStyle.Primary;
    }
  }

  private async registerSlashCommand(bot: DiscordBotClient, guildId: string, name: string, description: string, options: any[]): Promise<void> {
    if (!bot.rest || !bot.client.user) {
      throw new Error('Discord client not ready');
    }

    console.log(`[Server] [${bot.id}] Registering slash command /${name} for guild ${guildId}, bot user ${bot.client.user.id}`);

    const command = new SlashCommandBuilder()
      .setName(name)
      .setDescription(description);

    // Add options
    for (const opt of options) {
      switch (opt.type.toLowerCase()) {
        case 'string':
          command.addStringOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'integer':
          command.addIntegerOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'boolean':
          command.addBooleanOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'user':
          command.addUserOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
        case 'channel':
          command.addChannelOption(option =>
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(opt.required ?? false)
          );
          break;
      }
    }

    // Register command to guild (POST adds individual command without overwriting others)
    try {
      const route = Routes.applicationGuildCommands(bot.client.user.id, guildId);
      console.log(`[Server] [${bot.id}] POST to Discord API: ${route}`);
      const result = await bot.rest.post(route, { body: command.toJSON() });
      console.log(`[Server] [${bot.id}] Successfully registered /${name}:`, result);
    } catch (error: any) {
      console.error(`[Server] [${bot.id}] Discord API error:`, {
        status: error.status,
        code: error.code,
        message: error.message,
        requestBody: error.requestBody
      });
      throw error;
    }
  }

  private async unregisterSlashCommand(bot: DiscordBotClient, guildId: string, name: string): Promise<void> {
    if (!bot.rest || !bot.client.user) {
      return;
    }

    try {
      // Get all registered commands
      const commands: any = await bot.rest.get(
        Routes.applicationGuildCommands(bot.client.user.id, guildId)
      );

      // Find and delete the command
      const command = commands.find((c: any) => c.name === name);
      if (command) {
        await bot.rest.delete(
          Routes.applicationGuildCommand(bot.client.user.id, guildId, command.id)
        );
      }
    } catch (error) {
      console.error(`[Server] [${bot.id}] Error unregistering command ${name}:`, error);
    }
  }
  
  private generateConnectionId(): string {
    return Math.random().toString(36).substring(2, 15);
  }
  
  /**
   * Notify hot reload clients about module updates
   */
  public notifyModuleUpdate(moduleName: string): void {
    if (!this.hotReloadWss) return;
    
    const notification = JSON.stringify({
      type: 'module-updated',
      module: moduleName,
      timestamp: Date.now()
    });
    
    this.hotReloadWss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(notification);
      }
    });
  }
  
  async init() {
    // Register Discord modules
    await this.registerDiscordModules();
  }
  
  /**
   * Start the server with multiple bot configurations
   */
  async start(botConfigs: BotConfig[]) {
    // Initialize all bots
    console.log('🔐 Initializing Discord bots...');
    await this.initBots(botConfigs);

    if (this.bots.size === 0) {
      console.warn('⚠️  No bots initialized! Server will run but no Discord connections available.');
    } else {
      console.log(`✅ ${this.bots.size} Discord bot(s) ready`);
      for (const [id, bot] of this.bots) {
        console.log(`   - ${id}: ${bot.client.user?.tag}`);
      }
    }

    // Start Express server
    this.app.listen(this.httpPort, () => {
      console.log(`\n🚀 Combined Discord AXON Server (Multi-Bot)`);
      console.log(`   HTTP server on port ${this.httpPort}`);
      console.log(`   WebSocket server on port ${this.wsPort}`);
      console.log(`   Module server at http://localhost:${this.httpPort}/modules/manifest`);
      console.log(`   Bot list at http://localhost:${this.httpPort}/bots`);
      console.log(`\n📡 Agents can connect to: ws://localhost:${this.wsPort}/ws`);
      console.log(`   Specify botId in auth message to select a bot`);
    });

    // Start hot reload WebSocket server
    const hotReloadPort = this.modulePort + 1;
    this.hotReloadWss = new WebSocketServer({ port: hotReloadPort });
    console.log(`   Hot reload WebSocket on port ${hotReloadPort}`);

    this.hotReloadWss.on('connection', (ws: WebSocket) => {
      console.log('[HotReload] Client connected');

      ws.on('close', () => {
        console.log('[HotReload] Client disconnected');
      });
    });
  }

  /**
   * Backwards compatibility: Start with a single bot token
   * @deprecated Use start(botConfigs) instead
   */
  async startSingleBot(botToken: string) {
    await this.start([{ name: 'default', token: botToken }]);
  }

  /**
   * Split a message into chunks that fit within Discord's 2000 character limit
   */
  private splitMessage(content: string, maxLength: number = 1900): string[] {
    if (content.length <= maxLength) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline, period, space)
      let breakPoint = maxLength;

      // Try to break at newline
      const lastNewline = remaining.lastIndexOf('\n', maxLength);
      if (lastNewline > maxLength * 0.5) {
        breakPoint = lastNewline + 1;
      } else {
        // Try to break at sentence end
        const lastPeriod = remaining.lastIndexOf('. ', maxLength);
        if (lastPeriod > maxLength * 0.5) {
          breakPoint = lastPeriod + 2;
        } else {
          // Break at space
          const lastSpace = remaining.lastIndexOf(' ', maxLength);
          if (lastSpace > maxLength * 0.5) {
            breakPoint = lastSpace + 1;
          }
        }
      }

      chunks.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }
}

export { CombinedDiscordAxonServer };
export type { AxonConnection, DiscordBotClient };
