import { verifyDiscordSignature } from '../common/crypto.js';
import { logger } from '../common/logger.js';

export class DiscordInteractionsHandler {
  /**
   * @param {object} options
   * @param {string} options.publicKey - Discord Application Public Key
   * @param {import('./commands.js').DiscordCommands} options.commands
   */
  constructor({ publicKey, commands }) {
    this.publicKey = publicKey;
    this.commands = commands;
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
      const commandName = data.data.name;
      logger.info(`Discord slash command received: /${commandName}`);
      const response = this.commands.dispatch(commandName);
      return { status: 200, body: response };
    }

    return { status: 400, body: { error: 'Unsupported interaction type' } };
  }
}
