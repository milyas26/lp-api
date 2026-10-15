import { log } from "./logger";

/** Optional Telegram alerts; no-op when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. */
export class Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.warn("telegram send failed", e);
    }
  }
}
