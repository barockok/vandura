import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "@slack/bolt";
import { SlackGateway } from "../../src/slack/gateway.js";

function createMockApp() {
  return {
    event: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as App;
}

describe("SlackGateway", () => {
  let mockApp: App;
  let gateway: SlackGateway;

  beforeEach(() => {
    mockApp = createMockApp();
    gateway = new SlackGateway(mockApp);
  });

  describe("onMention", () => {
    it("registers an app_mention event handler", () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      expect(mockApp.event).toHaveBeenCalledWith("app_mention", expect.any(Function));
    });

    it("invokes handler with correct payload on app_mention", async () => {
      const handler = vi.fn();
      gateway.onMention(handler);

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const say = vi.fn();
      await registeredCallback({
        event: {
          user: "U123",
          text: "<@BOT> hello",
          channel: "C456",
          ts: "1234567890.123456",
        },
        say,
      });

      expect(handler).toHaveBeenCalledWith({
        user: "U123",
        text: "<@BOT> hello",
        channel: "C456",
        ts: "1234567890.123456",
        say,
      });
    });
  });

  describe("onThreadMessage", () => {
    it("registers a message event handler", () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      expect(mockApp.event).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("invokes handler for thread replies with thread_ts", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const say = vi.fn();
      await registeredCallback({
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

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const say = vi.fn();
      await registeredCallback({
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

    it("ignores bot messages", async () => {
      const handler = vi.fn();
      gateway.onThreadMessage(handler);

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const say = vi.fn();
      await registeredCallback({
        event: {
          user: "U123",
          text: "bot reply",
          channel: "C456",
          ts: "1234567890.200000",
          thread_ts: "1234567890.100000",
          bot_id: "B999",
        },
        say,
      });

      expect(handler).not.toHaveBeenCalled();
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

      const registeredCallback = (mockApp.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
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
