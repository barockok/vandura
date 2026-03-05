export class CheckerFlow {
  extractCheckerFromReply(text: string): string | "skip" | null {
    const normalized = text.trim().toLowerCase();
    if (["skip", "none", "no checker", "n/a"].includes(normalized)) {
      return "skip";
    }
    const match = text.match(/<@(U[A-Z0-9]+)>/);
    return match ? match[1] : null;
  }

  buildNominationPrompt(): string {
    return "Who should be the checker for this task? Reply with @username, or say *skip* if no checker is needed.";
  }
}
