import { logger } from '../common/logger.js';

export class DiscordNotifier {
  /**
   * @param {object} options
   * @param {string} options.webhookUrl
   * @param {string} [options.botToken]
   * @param {string} [options.channelId]
   */
  constructor({ webhookUrl, botToken, channelId }) {
    this.webhookUrl = webhookUrl;
    this.botToken = botToken;
    this.channelId = channelId;
  }

  /**
   * Send an alert embed to Discord
   * @param {object} embed - { title, description, color, fields }
   * @param {number} maxRetries 
   * @returns {Promise<boolean>}
   */
  async sendAlert(embed, maxRetries = 3) {
    if (!this.webhookUrl && !this.botToken) {
      logger.debug('Discord notifier skipped: no webhookUrl or botToken configured');
      return false;
    }

    const payload = {
      username: 'VPS Monitor',
      avatar_url: 'https://cdn-icons-png.flaticon.com/512/900/900782.png',
      embeds: [
        {
          ...embed,
          timestamp: new Date().toISOString(),
          footer: {
            text: 'VPS Monitor V1 • 11Ship & AutoTrade'
          }
        }
      ]
    };

    let targetUrl = this.webhookUrl;
    let headers = { 'Content-Type': 'application/json' };

    if (!targetUrl && this.botToken && this.channelId) {
      targetUrl = `https://discord.com/api/v10/channels/${this.channelId}/messages`;
      headers['Authorization'] = `Bot ${this.botToken}`;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (res.status === 429) {
          // Rate limited
          const rateData = await res.json().catch(() => ({}));
          const retryAfterSec = rateData.retry_after || (attempt * 2);
          logger.warn(`Discord rate limited, retrying after ${retryAfterSec}s (attempt ${attempt}/${maxRetries})`);
          await new Promise(r => setTimeout(r, retryAfterSec * 1000));
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.error(`Discord alert failed HTTP ${res.status}: ${body}`);
          if (attempt === maxRetries) return false;
          await new Promise(r => setTimeout(r, attempt * 1000));
          continue;
        }

        logger.debug(`Discord alert sent: ${embed.title}`);
        return true;
      } catch (err) {
        logger.error(`Discord alert attempt ${attempt} error: ${err.message}`);
        if (attempt === maxRetries) return false;
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }

    return false;
  }
}
