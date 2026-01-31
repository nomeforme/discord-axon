# Discord AXON

Discord client for Connectome gRPC microservices architecture.

## Overview

Discord AXON connects to Discord and the Connectome gRPC server, enabling AI agents to communicate through Discord. It handles:

- Receiving messages via Discord.js
- Sending responses to Discord channels
- Image attachment processing (download, compress, base64 encode)
- Multi-bot support with independent tokens
- Mention resolution (@username to Discord format)
- Bot-to-bot interaction limiting

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DOCKER COMPOSE                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │  CONNECTOME-TS (gRPC Server :50051)                 │   │
│  │  • VEIL State Management                            │   │
│  │  • Context rendering                                │   │
│  │  • Facet storage                                    │   │
│  └───────────────────────┬─────────────────────────────┘   │
│                          │ gRPC                             │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  DISCORD-AXON (gRPC Client)                         │   │
│  │  • DiscordMessageReceptor (receive messages)        │   │
│  │  • DiscordAgentEffector (run LLM, send responses)   │   │
│  │  • FocusedContextTransform (build LLM context)      │   │
│  │  • ToolLoopAgent (Anthropic/Bedrock with tools)     │   │
│  └───────────────────────┬─────────────────────────────┘   │
│                          │ WebSocket                        │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  DISCORD API                                        │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Discord bot tokens (comma-separated, match config.json order)
DISCORD_BOT_TOKENS=token1,token2,token3

# Default guild (optional)
DISCORD_GUILD_ID=

# Connectome gRPC server
CONNECTOME_GRPC_HOST=connectome:50051

# LLM Provider (choose one or both)
ANTHROPIC_API_KEY=sk-ant-api03-...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

### Bot Configuration (config.json)

```json
{
  "active_bots": ["bot-name-1", "bot-name-2"],
  "bots": {
    "bot-name-1": {
      "name": "bot-name-1",
      "model": "claude-sonnet-4-20250514",
      "prompt": "You are a helpful assistant.",
      "max_tokens": 4096,
      "tools": ["fetch"],
      "guild_id": null,
      "auto_join_channels": []
    }
  }
}
```

### Model Naming

- **Anthropic API**: Use model IDs directly (e.g., `claude-sonnet-4-20250514`)
- **AWS Bedrock**: Prefix with `bedrock-` (e.g., `bedrock-claude-3-5-sonnet-20241022`)

## Running

### With Docker Compose

```bash
docker compose up discord-axon
```

### Development

```bash
npm install
npm run start:grpc
```

## Features

- **Multi-bot**: Multiple bots with different personalities/models
- **Image Processing**: Receives and processes image attachments
- **Tool Support**: Extensible tool system (fetch, etc.)
- **Mention Resolution**: Converts @username to Discord mentions
- **Bot Limiting**: Configurable bot-to-bot interaction limits
- **Random Replies**: Optional random reply chance for ambient engagement
