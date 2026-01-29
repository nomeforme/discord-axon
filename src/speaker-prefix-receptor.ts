/**
 * SpeakerPrefixReceptor - Prepends bot name to agent speech content
 *
 * Intercepts veil:operation events for speech facets from agents and
 * modifies the content to prepend the agent's name (e.g., "claude-opus-4-5: Hello!").
 * This allows other bots reading history to identify who said what.
 *
 * Also strips XML-like tags (<my_turn>, <tool-use>, etc.) that may leak from
 * HUD formatting or LLM output.
 *
 * The prefix is stripped before sending to Discord (in discord-app.ts handleSpeech).
 *
 * Adapted from signal-axon-host's SpeakerPrefixReceptor.
 */

import { Component, priorityConstraint, ComponentPriority } from 'connectome-ts';
import type { ExecutionContext } from 'connectome-ts';

export class SpeakerPrefixReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  readonly topics = ['veil:operation'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (event.topic !== 'veil:operation') return;

    const payload = event.payload as any;

    // The payload structure is { operation: { type, facet } }
    const op = payload?.operation;
    const operation = op?.type;
    const facet = op?.facet;

    // Only process addFacet operations
    if (operation !== 'addFacet') {
      return;
    }

    // Only process speech facets from agents
    if (facet?.type !== 'speech' || !facet.agentName || !facet.agentId) {
      return;
    }

    const agentName = facet.agentName;
    let content = facet.content || '';
    const originalContent = content;

    // Extract content from @discord-control.send_message({...}) pattern
    // LLM sometimes outputs tool syntax as text instead of using actual tools
    const discordControlMatch = content.match(/@discord-control\.send_message\s*\(\s*(\{[\s\S]*?\})\s*\)/);
    if (discordControlMatch) {
      try {
        const jsonStr = discordControlMatch[1];
        const parsed = JSON.parse(jsonStr);
        if (parsed.content) {
          content = parsed.content;
          console.log(`[SpeakerPrefixReceptor] Extracted content from @discord-control.send_message for ${agentName}`);
        }
      } catch (e) {
        // JSON parse failed, try regex extraction for content field
        const contentMatch = discordControlMatch[1].match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (contentMatch) {
          // Unescape the content
          content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          console.log(`[SpeakerPrefixReceptor] Extracted content via regex from @discord-control.send_message for ${agentName}`);
        }
      }
    }

    // Strip XML-like tags (<my_turn>, </my_turn>, <tool-use>, etc.)
    // BUT preserve Discord mentions (<@username>, <@!userid>, <#channel>, <@&role>)
    content = content.replace(/<(?!@|#)[^>]+>/g, '').trim();
    if (originalContent !== content) {
      console.log(`[SpeakerPrefixReceptor] Cleaned content for ${agentName}`);
    }

    // Update facet content with cleaned version (XML tags stripped, @discord-control extracted)
    if (originalContent !== content) {
      facet.content = content;
    }

    // DISABLED: Speaker prefix causes issues with duplicate display
    // The prefix was meant for multi-bot history identification but Discord
    // already shows usernames, so it's not needed
    // console.log(`[SpeakerPrefixReceptor] Adding prefix "${agentName}:" to facet ${facet.id}`);
    // facet.content = `${agentName}: ${content}`;
  }
}
