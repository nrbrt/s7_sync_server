// logger.js — Winston logger extracted from sws3.js (behavior-identical).
// Timestamps in Europe/Amsterdam local time with ms; file-only (no console)
// to avoid PM2 log spam. Daily rotation, 7-day retention.
const winston = require('winston');
require('winston-daily-rotate-file');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => {
        const now = new Date();
        const local = now.toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        return `${local}.${ms}`;
      }
    }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'plc-app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'info',
      maxSize: '50m',
      maxFiles: '7d',
    }),
    new winston.transports.DailyRotateFile({
      filename: 'plc-errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '50m',
      maxFiles: '7d',
    }),
  ],
});

module.exports = logger;
