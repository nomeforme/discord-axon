/**
 * Clean speech content before sending to Discord
 * Adapted from SpeakerPrefixReceptor
 */
export function cleanSpeechContent(content: string): string {
  let cleaned = content;

  // Extract content from @discord-control.send_message({...}) pattern
  // LLM sometimes outputs tool syntax as text instead of using actual tools
  const discordControlMatch = cleaned.match(/@discord-control\.send_message\s*\(\s*(\{[\s\S]*?\})\s*\)/);
  if (discordControlMatch) {
    try {
      const jsonStr = discordControlMatch[1];
      const parsed = JSON.parse(jsonStr);
      if (parsed.content) {
        cleaned = parsed.content;
        console.log(`[SpeechCleanup] Extracted content from @discord-control.send_message`);
      }
    } catch {
      // JSON parse failed, try regex extraction for content field
      const contentMatch = discordControlMatch[1].match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (contentMatch) {
        // Unescape the content
        cleaned = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        console.log(`[SpeechCleanup] Extracted content via regex from @discord-control.send_message`);
      }
    }
  }

  // Strip XML-like tags (<my_turn>, </my_turn>, <tool-use>, etc.)
  // BUT preserve Discord mentions (<@username>, <@!userid>, <#channel>, <@&role>)
  const before = cleaned;
  cleaned = cleaned.replace(/<(?!@|#)[^>]+>/g, '').trim();
  if (before !== cleaned) {
    console.log(`[SpeechCleanup] Stripped XML tags from content`);
  }

  return cleaned;
}
