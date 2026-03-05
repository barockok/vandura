import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "@slack/bolt";
import { SlackGateway } from "../../src/slack/gateway.js";

function createMockApp() {
  return {
    event: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as App;
}

function getHandlerFor(mockApp: App, eventType: string, callIndex = 0) {
  const calls = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls
    .filter((c: unknown[]) => c[0] === eventType);
  return calls[callIndex]?.[1];
}

describe("SlackGateway", () => {
  let mockApp: App;
  let gateway: SlackGateway;

  beforeEach(() => {
    mockApp = createMockApp();
    gateway = new SlackGateway(mockApp);
    gateway.setBotUserId("UBOT");
  });

  describe("onMention", () => {
    it("registers app_mention and message event handlers", () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      expect(mockApp.event).toHaveBeenCalledWith("app_mention", expect.any(Function));
      expect(mockApp.event).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("invokes handler on app_mention event", async () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      const callback = getHandlerFor(mockApp, "app_mention");
      const say = vi.fn();
      await callback({
        event: {
          user: "U123",
          text: "<@UBOT> hello",
          channel: "C456",
          ts: "1234567890.123456",
        },
        say,
      });

      expect(handler).toHaveBeenCalledWith({
        user: "U123",
        text: "<@UBOT> hello",
        channel: "C456",
        ts: "1234567890.123456",
        say,
      });
    });

    it("invokes handler on message event with bot mention (for bot-authored messages)", async () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "U123",
          text: "<@UBOT> hello from bot",
          channel: "C456",
          ts: "1234567890.123456",
          bot_id: "BOTHER",
        },
        say,
      });

      expect(handler).toHaveBeenCalledWith({
        user: "U123",
        text: "<@UBOT> hello from bot",
        channel: "C456",
        ts: "1234567890.123456",
        say,
      });
    });

    it("ignores message events without bot mention", async () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "U123",
          text: "no mention here",
          channel: "C456",
          ts: "1234567890.123456",
        },
        say,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores message events from our own bot", async () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "UBOT",
          text: "<@UBOT> self mention",
          channel: "C456",
          ts: "1234567890.123456",
        },
        say,
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onThreadMessage", () => {
    it("registers a message event handler", () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      expect(mockApp.event).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("invokes handler for thread replies", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "U123",
          text: "thread reply",
          channel: "C456",
          ts: "1234567890.200000",
          thread_ts: "1234567890.100000",
        },
        say,
      });

      expect(handler).toHaveBeenCalledWith({
        user: "U123",
        text: "thread reply",
        channel: "C456",
        ts: "1234567890.200000",
        thread_ts: "1234567890.100000",
        say,
      });
    });

    it("ignores messages without thread_ts", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "U123",
          text: "top-level message",
          channel: "C456",
          ts: "1234567890.200000",
        },
        say,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores thread messages from our own bot", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "UBOT",
          text: "bot reply",
          channel: "C456",
          ts: "1234567890.200000",
          thread_ts: "1234567890.100000",
        },
        say,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("allows thread messages from other bots", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const callback = getHandlerFor(mockApp, "message");
      const say = vi.fn();
      await callback({
        event: {
          user: "UOTHER",
          text: "other bot reply",
          channel: "C456",
          ts: "1234567890.200000",
          thread_ts: "1234567890.100000",
          bot_id: "BOTHER",
        },
        say,
      });

      expect(handler).toHaveBeenCalled();
    });
  });

  describe("onMemberJoined", () => {
    it("registers a member_joined_channel event handler", () => {
      const handler = vi.fn();
      gateway.onMemberJoined(handler);

      expect(mockApp.event).toHaveBeenCalledWith("member_joined_channel", expect.any(Function));
    });

    it("invokes handler with user and channel", async () => {
      const handler = vi.fn();
      gateway.onMemberJoined(handler);

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "member_joined_channel",
      )![1];
      await registeredCallback({
        event: {
          user: "U123",
          channel: "C456",
        },
      });

      expect(handler).toHaveBeenCalledWith({
        user: "U123",
        channel: "C456",
      });
    });
  });

  describe("start", () => {
    it("calls app.start()", async () => {
      await gateway.start();
      expect(mockApp.start).toHaveBeenCalled();
    });
  });
});
