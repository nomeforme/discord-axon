/**
 * Mention resolution utilities for Discord
 * Resolves <@username> mentions to <@userid> format (outgoing)
 * Resolves <@userid> mentions to @name format (incoming context)
 */

import type { Guild } from 'discord.js';

// Global cache for mention resolution (username -> Discord user ID)
const userNameToId = new Map<string, string>();
const roleNameToId = new Map<string, string>();
// Reverse cache (Discord user ID -> display name) for incoming resolution
const userIdToName = new Map<string, string>();

/**
 * Get the user name cache (for adding entries from outside)
 */
export function getUserNameCache(): Map<string, string> {
  return userNameToId;
}

/**
 * Get the reverse user ID cache (for adding entries from outside)
 */
export function getUserIdToNameCache(): Map<string, string> {
  return userIdToName;
}

/**
 * Resolve Discord mention IDs to readable names in message content.
 * Converts <@123456789> to @username for LLM context.
 */
export function resolveIncomingMentions(
  content: string,
  botUserIdToName: Map<string, string>
): string {
  // Match Discord mention patterns: <@ID> and <@!ID> (nickname mentions)
  return content.replace(/<@!?(\d+)>/g, (match, id) => {
    // Check bot names first
    const botName = botUserIdToName.get(id);
    if (botName) return `@${botName}`;

    // Check cached user names
    const userName = userIdToName.get(id);
    if (userName) return `@${userName}`;

    // Leave as-is if we can't resolve
    return match;
  });
}

/**
 * Resolve <@username> mentions to <@userid> format for Discord
 * Also handles <#channel> and <@&role> mentions
 */
export async function resolveMentions(
  content: string,
  guild: Guild | undefined,
  botUserIdToName: Map<string, string>
): Promise<string> {
  // Collect replacements to apply atomically at the end
  const replacements: Array<{ from: string; to: string }> = [];

  // Find all @mentions: <@username> - Unicode-aware pattern
  // Allow spaces in names (for display names like "claude opus 4")
  const atMentionPattern = /<@([^<>@#&!]+?)>/gu;
  const atMatches = [...content.matchAll(atMentionPattern)];

  for (const match of atMatches) {
    const name = match[1];
    const nameLower = name.toLowerCase();

    // Skip if already a numeric ID
    if (/^\d+$/.test(name)) continue;

    // Check cache first
    let userId = userNameToId.get(nameLower);

    // Try role cache
    let roleId: string | undefined;
    if (!userId) {
      roleId = roleNameToId.get(nameLower);
    }

    // Discord API lookup if not in cache
    if (!userId && !roleId && guild) {
      try {
        // Search guild members by username
        const members = await guild.members.search({ query: name, limit: 10 });
        const member = members.find((m) =>
          m.user.username.toLowerCase() === nameLower ||
          m.user.displayName?.toLowerCase() === nameLower ||
          m.nickname?.toLowerCase() === nameLower
        );

        if (member) {
          userId = member.user.id;
          if (userId) {
            userNameToId.set(nameLower, userId);
            console.log(`[MentionResolver] Resolved <@${name}> -> <@${userId}> via search`);
          }
        }
      } catch {
        // Search failed, try full member fetch as fallback
        try {
          const members = await guild.members.fetch({ limit: 1000 });
          const member = members.find((m) =>
            m.user.username.toLowerCase() === nameLower ||
            m.user.displayName?.toLowerCase() === nameLower ||
            m.nickname?.toLowerCase() === nameLower
          );

          if (member) {
            userId = member.user.id;
            if (userId) {
              userNameToId.set(nameLower, userId);
              console.log(`[MentionResolver] Resolved <@${name}> -> <@${userId}> via fetch`);
            }
          }
        } catch {
          // Ignore fetch errors
        }
      }

      // Try as role if user not found
      if (!userId) {
        try {
          const role = guild.roles.cache.find((r) =>
            r.name.toLowerCase() === nameLower
          );
          if (role && role.id) {
            roleId = role.id;
            roleNameToId.set(nameLower, role.id);
            console.log(`[MentionResolver] Resolved role <@${name}> -> <@&${role.id}>`);
          }
        } catch {
          // Ignore role lookup errors
        }
      }
    }

    // Check our bot names - compare directly without stripping Unicode
    if (!userId && !roleId) {
      for (const [botUserId, botName] of botUserIdToName) {
        // Direct lowercase comparison
        if (botName.toLowerCase() === nameLower) {
          userId = botUserId;
          userNameToId.set(nameLower, userId);
          console.log(`[MentionResolver] Resolved bot <@${name}> -> <@${userId}> (exact match)`);
          break;
        }
        // Config name with spaces instead of dashes
        const botNameSpaced = botName.toLowerCase().replace(/-/g, ' ');
        if (botNameSpaced === nameLower) {
          userId = botUserId;
          userNameToId.set(nameLower, userId);
          console.log(`[MentionResolver] Resolved bot <@${name}> -> <@${userId}> (spaced match)`);
          break;
        }
        // Partial match - name contains bot name or vice versa
        const nameAlphaNum = nameLower.replace(/[^a-z0-9]/g, '');
        const botNameAlphaNum = botName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (nameAlphaNum && botNameAlphaNum &&
            (botNameAlphaNum.startsWith(nameAlphaNum) || nameAlphaNum.startsWith(botNameAlphaNum))) {
          userId = botUserId;
          userNameToId.set(nameLower, userId);
          console.log(`[MentionResolver] Resolved bot <@${name}> -> <@${userId}> (partial match: ${botName})`);
          break;
        }
      }
    }

    // Add to replacements
    if (userId) {
      replacements.push({ from: `<@${name}>`, to: `<@${userId}>` });
    } else if (roleId) {
      replacements.push({ from: `<@${name}>`, to: `<@&${roleId}>` });
    }
  }

  // Find bare @mentions: @username (without angle brackets)
  // Bots see @name in context and naturally output @name format
  // Sort bot names by length (longest first) to avoid partial matches
  const botNames = [...botUserIdToName.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [botUserId, botName] of botNames) {
    const pattern = new RegExp(`@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.:;!?)'"\\n]|$)`, 'gi');
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const matchStr = match[0];
      // Skip if this is already inside angle brackets (handled above)
      const idx = content.indexOf(matchStr);
      if (idx > 0 && content[idx - 1] === '<') continue;

      if (!replacements.some(r => r.from === matchStr)) {
        replacements.push({ from: matchStr, to: `<@${botUserId}>` });
        console.log(`[MentionResolver] Resolved bare ${matchStr} -> <@${botUserId}>`);
      }
    }
  }

  // Also check cached usernames for bare @mentions
  for (const [name, userId] of userNameToId) {
    const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.:;!?)'"\\n]|$)`, 'gi');
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const matchStr = match[0];
      const idx = content.indexOf(matchStr);
      if (idx > 0 && content[idx - 1] === '<') continue;

      if (!replacements.some(r => r.from === matchStr)) {
        replacements.push({ from: matchStr, to: `<@${userId}>` });
        console.log(`[MentionResolver] Resolved bare ${matchStr} -> <@${userId}>`);
      }
    }
  }

  // Handle channel mentions: <#channelname>
  const channelPattern = /<#([^<>@#&!]+?)>/gu;
  const channelMatches = [...content.matchAll(channelPattern)];

  for (const match of channelMatches) {
    const channelName = match[1];
    const channelNameLower = channelName.toLowerCase();

    // Skip if already a numeric ID
    if (/^\d+$/.test(channelName)) continue;

    if (guild) {
      try {
        const channel = guild.channels.cache.find((c) =>
          c.name?.toLowerCase() === channelNameLower
        );
        if (channel) {
          replacements.push({ from: `<#${channelName}>`, to: `<#${channel.id}>` });
          console.log(`[MentionResolver] Resolved channel <#${channelName}> -> <#${channel.id}>`);
        }
      } catch {
        // Ignore channel lookup errors
      }
    }
  }

  // Apply all replacements
  let result = content;
  for (const { from, to } of replacements) {
    result = result.replace(from, to);
  }

  return result;
}
