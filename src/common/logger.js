export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
  constructor(level = LogLevel.INFO) {
    this.level = level;
  }

  setLevel(level) {
    this.level = level;
  }

  _format(levelName, message, extra = null) {
    const timestamp = new Date().toISOString();
    let text = `[${timestamp}] [${levelName}] ${message}`;
    if (extra) {
      if (extra instanceof Error) {
        text += `\n${extra.stack || extra.message}`;
      } else {
        try {
          // Redact potential sensitive keys in logs
          const sanitized = this._sanitize(extra);
          text += ` ${JSON.stringify(sanitized)}`;
        } catch {
          text += ` [Unserializable Object]`;
        }
      }
    }
    return text;
  }

  _sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this._sanitize(item));

    const sensitiveKeys = ['secret', 'password', 'token', 'pass', 'key', 'webhook', 'auth'];
    const res = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.some(s => k.toLowerCase().includes(s))) {
        res[k] = '[REDACTED]';
      } else if (typeof v === 'object') {
        res[k] = this._sanitize(v);
      } else {
        res[k] = v;
      }
    }
    return res;
  }

  debug(msg, extra) {
    if (this.level <= LogLevel.DEBUG) console.debug(this._format('DEBUG', msg, extra));
  }

  info(msg, extra) {
    if (this.level <= LogLevel.INFO) console.log(this._format('INFO', msg, extra));
  }

  warn(msg, extra) {
    if (this.level <= LogLevel.WARN) console.warn(this._format('WARN', msg, extra));
  }

  error(msg, extra) {
    if (this.level <= LogLevel.ERROR) console.error(this._format('ERROR', msg, extra));
  }
}

export const logger = new Logger();
