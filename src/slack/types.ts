export interface SlackEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts: string;
}
