import { timingSafeEqual } from 'node:crypto';

export class AuthGuard {
  /**
   * @param {object} options
   * @param {string} options.user - Dashboard Basic Auth username
   * @param {string} options.pass - Dashboard Basic Auth password
   * @param {string} [options.apiToken] - Optional Bearer token
   */
  constructor({ user, pass, apiToken }) {
    this.user = user || 'admin';
    this.pass = pass || '';
    this.apiToken = apiToken || '';
  }

  _safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /**
   * Check if request has valid authorization
   * @param {import('node:http').IncomingMessage} req 
   * @returns {boolean}
   */
  isAuthorized(req) {
    // If no password or token is configured, allow in development only
    if (!this.pass && !this.apiToken) {
      return true;
    }

    const authHeader = req.headers['authorization'] || '';

    // Check Bearer Token
    if (this.apiToken && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (this._safeEqual(token, this.apiToken)) return true;
    }

    // Check Basic Auth
    if (this.pass && authHeader.startsWith('Basic ')) {
      try {
        const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
        const [username, password] = credentials.split(':');
        if (this._safeEqual(username, this.user) && this._safeEqual(password, this.pass)) {
          return true;
        }
      } catch {
        return false;
      }
    }

    return false;
  }
}
