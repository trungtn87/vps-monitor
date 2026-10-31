import { verifyDiscordSignature } from '../common/crypto.js';
import { logger } from '../common/logger.js';

export class DiscordInteractionsHandler {
  /**
   * @param {object} options
   * @param {string} options.publicKey - Discord Application Public Key
   * @param {import('./commands.js').DiscordCommands} options.commands
   * @param {string[]} [options.allowedUserIds] - Allowed Discord user IDs (Finding 9)
   * @param {string[]} [options.allowedGuildIds] - Allowed Discord guild/server IDs (Finding 9)
   * @param {string} [options.nodeEnv] - Environment mode ('production' | 'development' | 'test')
   */
  constructor({ publicKey, commands, allowedUserIds = [], allowedGuildIds = [], nodeEnv = 'development' }) {
    this.publicKey = publicKey;
    this.commands = commands;
    this.allowedUserIds = allowedUserIds;
    this.allowedGuildIds = allowedGuildIds;
    this.nodeEnv = nodeEnv;
  }

  /**
   * Handle incoming Discord interaction HTTP request
   * @param {string} rawBody 
   * @param {string} signature 
   * @param {string} timestamp 
   * @returns {{ status: number, body: object|string }}
   */
  handle(rawBody, signature, timestamp) {
    // 1. Signature Verification
    if (!this.publicKey) {
      logger.warn('Discord interactions called but DISCORD_PUBLIC_KEY is not configured');
      return { status: 500, body: { error: 'Discord public key not configured' } };
    }

    const isValid = verifyDiscordSignature(rawBody, signature, timestamp, this.publicKey);
    if (!isValid) {
      logger.warn('Discord interaction signature verification failed');
      return { status: 401, body: 'Invalid request signature' };
    }

    // 2. Parse Body
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: 'Invalid JSON payload' };
    }

    // 3. Discord PING (Type 1)
    if (data.type === 1) {
      return { status: 200, body: { type: 1 } }; // PONG
    }

    // 4. Discord APPLICATION_COMMAND (Type 2)
    if (data.type === 2 && data.data && data.data.name) {
      // Blocker 5: In production, allowlists cannot be empty (Fail-Closed)
      const hasRestrictions = this.allowedGuildIds.length > 0 || this.allowedUserIds.length > 0;
      if (this.nodeEnv === 'production' && !hasRestrictions) {
        logger.warn(`Discord command /${data.data.name} rejected: production requires DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_GUILD_IDS`);
        return {
          status: 200,
          body: {
            type: 4,
            data: { content: '⛔ Chế độ production yêu cầu cấu hình danh sách được phép (DISCORD_ALLOWED_USER_IDS hoặc DISCORD_ALLOWED_GUILD_IDS).' }
          }
        };
      }

      // Finding 9: Access restriction by Guild ID
      if (this.allowedGuildIds.length > 0) {
        const guildId = data.guild_id;
        if (!guildId || !this.allowedGuildIds.includes(guildId)) {
          logger.warn(`Discord command /${data.data.name} rejected from unauthorized guild ${guildId}`);
          return {
            status: 200,
            body: {
              type: 4,
              data: { content: '⛔ Lệnh chỉ được phép thực hiện trên Discord Server được ủy quyền.' }
            }
          };
        }
      }

      // Finding 9: Access restriction by User ID
      if (this.allowedUserIds.length > 0) {
        const userId = data.member?.user?.id || data.user?.id;
        if (!userId || !this.allowedUserIds.includes(userId)) {
          logger.warn(`Discord command /${data.data.name} rejected from unauthorized user ${userId}`);
          return {
            status: 200,
            body: {
              type: 4,
              data: { content: '⛔ Bạn không có quyền thực hiện lệnh tra cứu này.' }
            }
          };
        }
      }

      const commandName = data.data.name;
      logger.info(`Discord slash command received: /${commandName}`);
      const response = this.commands.dispatch(commandName);
      return { status: 200, body: response };
    }

    return { status: 400, body: { error: 'Unsupported interaction type' } };
  }
}
