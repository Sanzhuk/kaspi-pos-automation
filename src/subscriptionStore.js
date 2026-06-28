import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_FILE = path.join(__dirname, '..', 'subscriptions.json');

const subscriptions = new Map();

// ─── Persistence ───

export const saveSubscriptions = () => {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(Object.fromEntries(subscriptions), null, 2));
  } catch (err) {
    logger.error('SUBSCRIPTION', 'Failed to save subscriptions.json', err.message);
  }
};

export const loadSubscriptions = () => {
  try {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    for (const [id, sub] of Object.entries(data)) {
      subscriptions.set(id, sub);
    }
    if (subscriptions.size > 0) {
      logger.info('SUBSCRIPTION', `Restored ${subscriptions.size} subscriptions from file`);
    }
  } catch (err) {
    logger.error('SUBSCRIPTION', 'Failed to load subscriptions.json', err.message);
  }
};

// ─── CRUD ───

export const getSubscription = (id) => subscriptions.get(id) ?? null;

export const listSubscriptions = ({ status } = {}) => {
  const all = Array.from(subscriptions.values());
  return status ? all.filter((s) => s.status === status) : all;
};

export const createSubscription = (data) => {
  const id = 'sub_' + crypto.randomUUID();
  const sub = { id, ...data };
  subscriptions.set(id, sub);
  saveSubscriptions();
  return sub;
};

export const updateSubscription = (id, updates) => {
  const sub = subscriptions.get(id);
  if (!sub) return null;
  const updated = { ...sub, ...updates };
  subscriptions.set(id, updated);
  saveSubscriptions();
  return updated;
};
