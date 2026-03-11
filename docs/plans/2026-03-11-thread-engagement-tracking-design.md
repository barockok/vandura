# Thread Engagement Tracking — Design Document

**Goal:** Prevent the bot from responding to side conversations in active threads. Track a `botEngaged` flag per session so the bot stays quiet when people talk to each other, and re-engages only when explicitly @mentioned.

**Architecture:** New `bot_engaged` boolean column on the sessions table. Gateway-level filtering in `app.ts` checks engagement state before forwarding thread messages to the worker. No timeouts, no schedulers — purely flag-based with @mention toggling.

## Engagement State Machine

New DB column: `bot_engaged BOOLEAN DEFAULT true` on `sessions` table.

Detection logic:
- `hasBotMention` = message text contains `<@BOT_USER_ID>`
- `hasOtherMention` = message text matches `<@SOME_OTHER_USER_ID>` (not the bot)

State transitions:

| Current State | Message Type | Action |
|---|---|---|
| engaged | mentions bot | stay engaged, forward |
| engaged | mentions others, not bot | disengage, skip |
| engaged | no mentions | stay engaged, forward |
| disengaged | mentions bot | re-engage, forward |
| disengaged | mentions others, not bot | stay disengaged, skip |
| disengaged | no mentions | stay disengaged, skip |

No special cases for approve/deny — all messages follow the same rules. Approvals require @mentioning the bot.

## Key Decisions

- **Flag location:** Database (survives restarts)
- **Default state:** Engaged (`true`) — bot starts active in every new thread
- **Re-engage trigger:** Only explicit `@bot` mention
- **No timeout:** Bot stays disengaged until re-mentioned
- **No special approval handling:** Approve/deny follow same engagement rules
