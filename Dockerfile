FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Copy dependencies from parent directory (build context is parent)
COPY connectome-axon-interfaces ./connectome-axon-interfaces
COPY axon-server ./axon-server
COPY connectome-ts ./connectome-ts
COPY discord-axon ./discord-axon

# Build dependencies in order
WORKDIR /workspace/connectome-axon-interfaces
RUN npm install && npm run build

WORKDIR /workspace/axon-server
RUN npm install && npm run build

WORKDIR /workspace/connectome-ts
RUN npm install && npm run build

WORKDIR /workspace/discord-axon
RUN npm install && npm run build

# Create state directory
RUN mkdir -p /workspace/discord-axon/discord-state

# Expose ports
# 8080 - HTTP API / Module serving
# 8081 - WebSocket for connectome clients
# 3000 - Debug interface
EXPOSE 8080 8081 3000

# Run the combined server + host
CMD ["node", "dist/combined-start.js"]
