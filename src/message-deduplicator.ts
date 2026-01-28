/**
 * MessageDeduplicator - Prevents duplicate frame creation for Discord messages
 *
 * When multiple bots receive the same Discord message via independent WebSockets,
 * only the first bot to call shouldEmit() will emit an event. Others are skipped.
 *
 * This reduces frame creation from N (number of bots) to 1 per message.
 *
 * Adapted from signal-axon's message-deduplicator.ts pattern.
 */

interface SeenMessage {
  firstReceiver: string;  // botId of first receiver
  timestamp: number;
}

class MessageDeduplicator {
  private seenMessages = new Map<string, SeenMessage>();
  private readonly TTL = 10000; // 10 second window for deduplication
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 5000; // Cleanup every 5 seconds

  /**
   * Check if this bot should emit an event for this message.
   *
   * @param messageId Unique Discord message ID
   * @param botId The bot identifier checking
   * @returns true if this bot should emit, false if another bot already emitted
   */
  shouldEmit(messageId: string, botId: string): boolean {
    // Periodic cleanup of old entries
    this.cleanupIfNeeded();

    // Check if already seen
    const existing = this.seenMessages.get(messageId);
    if (existing) {
      // Another bot already emitted this message
      console.log(`[MessageDeduplicator] Message ${messageId.substring(0, 20)}... already emitted by ${existing.firstReceiver}, skipping for ${botId}`);
      return false;
    }

    // First receiver - mark and allow emit
    this.seenMessages.set(messageId, {
      firstReceiver: botId,
      timestamp: Date.now()
    });

    console.log(`[MessageDeduplicator] Message ${messageId.substring(0, 20)}... first received by ${botId}, allowing emit`);
    return true;
  }

  /**
   * Get info about who first received a message (for debugging)
   */
  getFirstReceiver(messageId: string): string | undefined {
    return this.seenMessages.get(messageId)?.firstReceiver;
  }

  private cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL) {
      return;
    }

    this.lastCleanup = now;
    const expiry = now - this.TTL;

    let cleaned = 0;
    for (const [id, data] of this.seenMessages) {
      if (data.timestamp < expiry) {
        this.seenMessages.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[MessageDeduplicator] Cleaned ${cleaned} expired entries, ${this.seenMessages.size} remaining`);
    }
  }

  /**
   * Get current stats (for debugging)
   */
  getStats(): { trackedMessages: number; oldestTimestamp: number | null } {
    let oldest: number | null = null;
    for (const data of this.seenMessages.values()) {
      if (oldest === null || data.timestamp < oldest) {
        oldest = data.timestamp;
      }
    }
    return {
      trackedMessages: this.seenMessages.size,
      oldestTimestamp: oldest
    };
  }
}

// Singleton instance shared across all DiscordAfferent instances
export const messageDeduplicator = new MessageDeduplicator();
