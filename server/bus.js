import { EventEmitter } from 'node:events';

// In-process event bus feeding the SSE stream and the activity log.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const activity = [];

export function log(type, msg, data) {
  const entry = { ts: new Date().toISOString(), type, msg, ...(data ? { data } : {}) };
  activity.push(entry);
  if (activity.length > 400) activity.shift();
  bus.emit('activity', entry);
  if (process.env.QUIET !== '1') console.log(`[${entry.ts.slice(11, 19)}] ${type.padEnd(8)} ${msg}`);
}

export const recentActivity = (n = 100) => activity.slice(-n).reverse();
