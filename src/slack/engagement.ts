export interface EngagementAction {
  /** New engagement state to persist */
  engaged: boolean;
  /** Whether to forward this message to the worker */
  forward: boolean;
}

interface AnalyzeParams {
  text: string;
  botUserId: string;
  currentlyEngaged: boolean;
}

/**
 * Determine engagement state and whether to forward a thread message.
 *
 * Rules:
 * - If message mentions bot → engage + forward
 * - If message mentions others (not bot) → disengage + skip
 * - If no mentions → keep current state, forward only if engaged
 */
export function analyzeEngagement(params: AnalyzeParams): EngagementAction {
  const text = params.text || "";
  const { botUserId, currentlyEngaged } = params;

  const hasBotMention = text.includes(`<@${botUserId}>`);
  const hasOtherMention = new RegExp(`<@(?!${botUserId})[A-Z0-9]+>`).test(text);

  // Bot mentioned → always engage and forward
  if (hasBotMention) {
    return { engaged: true, forward: true };
  }

  // Others mentioned (not bot) → disengage and skip
  if (hasOtherMention) {
    return { engaged: false, forward: false };
  }

  // No mentions → maintain current state
  return { engaged: currentlyEngaged, forward: currentlyEngaged };
}
