import { describe, it, expect } from "vitest";
import { analyzeEngagement } from "../../src/slack/engagement.js";

const BOT = "UBOT123";

describe("engagement flow scenarios", () => {
  it("full conversation with side chat and re-engagement", () => {
    let engaged = true;

    // User talks to bot
    let action = analyzeEngagement({ text: `<@${BOT}> run a query`, botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // User follows up (no mention)
    action = analyzeEngagement({ text: "also check the logs", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // User tags a coworker
    action = analyzeEngagement({ text: "<@UCOWORKER> can you verify this?", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: false, forward: false });
    engaged = action.engaged;

    // Coworker replies (no mention)
    action = analyzeEngagement({ text: "yeah looks good to me", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: false, forward: false });
    engaged = action.engaged;

    // User re-engages bot
    action = analyzeEngagement({ text: `<@${BOT}> ok proceed`, botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // Bot stays engaged for follow-ups
    action = analyzeEngagement({ text: "and send me the results", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
  });
});
