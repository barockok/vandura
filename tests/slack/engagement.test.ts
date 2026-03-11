import { describe, it, expect } from "vitest";
import { analyzeEngagement, type EngagementAction } from "../../src/slack/engagement.js";

const BOT_ID = "U0AK72J10GH";

describe("analyzeEngagement", () => {
  describe("when currently engaged", () => {
    it("stays engaged when message mentions bot", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> check this`,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("disengages when message mentions another user but not bot", () => {
      const result = analyzeEngagement({
        text: "<@U999OTHER> can you look at this?",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });

    it("stays engaged when no mentions at all", () => {
      const result = analyzeEngagement({
        text: "here is some more context",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("stays engaged when message mentions both bot and others", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> and <@U999OTHER> check this`,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });
  });

  describe("when currently disengaged", () => {
    it("re-engages when message mentions bot", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> come back`,
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("stays disengaged when message mentions another user", () => {
      const result = analyzeEngagement({
        text: "<@U999OTHER> what do you think?",
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });

    it("stays disengaged when no mentions", () => {
      const result = analyzeEngagement({
        text: "yeah I agree with that",
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });
  });

  describe("edge cases", () => {
    it("handles empty text", () => {
      const result = analyzeEngagement({
        text: "",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("handles null/undefined text", () => {
      const result = analyzeEngagement({
        text: undefined as unknown as string,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("does not false-match user IDs embedded in URLs or text", () => {
      const result = analyzeEngagement({
        text: "check https://example.com/U999OTHER",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });
  });
});
