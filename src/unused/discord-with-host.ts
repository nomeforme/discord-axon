#!/usr/bin/env tsx

/**
 * Discord Bot Example using Connectome Host
 * 
 * This demonstrates the simplified architecture where the Host handles
 * all infrastructure concerns (persistence, restoration, debug UI, etc.)
 * and the application just defines the business logic.
 */

import { config as dotenvConfig } from 'dotenv';

import {
  ConnectomeHost,
  AnthropicProvider,
  MockLLMProvider,
  DebugLLMProvider
} from 'connectome-ts';
import { DiscordApplication } from './discord-app.js';
import { join } from 'path';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { loadConfig } from './config';

async function main() {
  console.log('🤖 Connectome Discord Bot with Host Architecture');
  console.log('================================================\n');
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const debugPort = parseInt(args.find(a => a.startsWith('--debug-port='))?.split('=')[1] || '3000');
  const useDebugLLM = args.includes('--debug-llm');
  const useBoxTest = args.includes('--box-test');
  
  if (reset) {
    console.log('🔄 Reset flag detected - starting fresh\n');
  }
  
  // Load environment variables from .env file
  dotenvConfig();
  
  // Load Discord config (from env vars or config.yaml)
  const discordConfig = loadConfig();
  const { botToken, guildId, channelId } = discordConfig;
  
  // Create LLM provider
  let llmProvider;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (useBoxTest) {
    console.log('🧪 Using Box Test Mock provider (simulates createBox action calls)');
    llmProvider = new MockLLMProvider();
  } else if (useDebugLLM) {
    console.log('🧪 Using Debug LLM provider (manual UI mode)');
    llmProvider = new DebugLLMProvider({ description: 'Discord Bot Debug Mode' });
  } else if (apiKey) {
    console.log('✅ Using Anthropic provider with Claude');
    llmProvider = new AnthropicProvider({
      apiKey,
      defaultMaxTokens: 1000
    });
  } else {
    console.log('⚠️  No ANTHROPIC_API_KEY found, using mock provider');
    const mockProvider = new MockLLMProvider();
    
    // Set some responses for the mock - including mentions and replies for testing
    mockProvider.setResponses([
      "<reply:@antra_tessera> Hello! Nice to meet you! Feel free to check <#general> for updates.",
      "<reply:@antra_tessera> Sure thing! I can definitely help with that. Check <#general> for more info!",
      "I'm connected to Discord and ready to chat! <@antra_tessera> let me know if you need anything!",
      "<reply:@antra_tessera> Great question! Let me think about that...",
      "Hey <@antra_tessera>! The mention system is working! Check <#general> to see more.",
      "<reply:@antra_tessera> Absolutely! The reply system is working too!",
      "Components can now declare their dependencies, and I can mention <@antra_tessera> too!",
      "<reply:@antra_tessera> This makes the whole system much more modular! See <#general>!",
    ]);
    
    llmProvider = mockProvider;
  }
  
  // Create the Host with configuration
  const providers: Record<string, any> = {
    'llm.primary': llmProvider
  };
  
  // Only add debug provider if debug LLM is enabled
  if (useDebugLLM) {
    providers['llm.debug'] = new DebugLLMProvider({ description: 'UI manual mode' });
  }
  
  const host = new ConnectomeHost({
    persistence: {
      enabled: true,
      storageDir: './discord-host-state',
      snapshotInterval: 5  // Low interval for testing
    },
    debug: {
      enabled: true,
      port: debugPort
    },
    providers,
    secrets: {
      'discord.token': discordConfig.botToken
    },
    reset
  });
  
  // Create the Discord application
  const app = new DiscordApplication({
    agentName: 'Connectome',
    systemPrompt: `You are Connectome, a helpful AI assistant in Discord.
You can join channels, send messages, and have conversations with users.
You remember all previous conversations and can reference them.
Be friendly, helpful, and engaging!`,
    llmProviderId: 'provider:llm.primary',
    botToken: botToken,  // Pass token directly for now (TODO: use Host's external system)
    discord: {
      host: 'localhost:8081',
      guild: guildId || '',
      modulePort: 8080,  // The Discord AXON server runs module serving on 8080
      autoJoinChannels: channelId ? [channelId] : []
    }
  } as any);
  
  // Start the application
  try {
    const space = await host.start(app);
    
    // Control panel is now created by the DiscordApplication during initialization
    // No need to create it here anymore
    
    console.log('\n📡 Discord bot is running!');
    console.log(`🔧 Debug interface: http://localhost:${debugPort}`);
    console.log('📋 Discord control panel loaded - use actions to manage servers/channels');
    
    if (useDebugLLM) {
      console.log('\n🧪 Debug LLM mode active - use the debug UI to complete responses manually');
      console.log('📝 Navigate to "Manual LLM Completions" panel to handle requests');
    }
    
    console.log('\nSend messages in Discord to interact with the bot.');
    console.log('Use the debug interface to view VEIL state and execute control panel actions.\n');
    
    // Handle shutdown gracefully
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      try {
        await host.stop();
        console.log('✅ State saved. Goodbye!');
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
      }
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

// Run the application
main().catch(console.error);
