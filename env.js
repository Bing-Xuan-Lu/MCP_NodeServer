/**
 * env.js — Centralized environment variable loader
 *
 * All hooks and the MCP server import from here instead of
 * reading process.env directly. dotenv loads .env from the
 * MCP_Server root regardless of the caller's CWD.
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// ── Load .env from MCP_Server root ───────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '.env'), quiet: true });

// ── Helpers ──────────────────────────────────────────────
const env = (key, fallback = '') => process.env[key] || fallback;
const envBool = (key, fallback = false) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true';
};
const envInt = (key, fallback) => {
  const v = parseInt(process.env[key], 10);
  return Number.isNaN(v) ? fallback : v;
};

// ── System ───────────────────────────────────────────────
export const HOME = process.env.HOME || process.env.USERPROFILE || '';
export const MCP_ROOT = __dirname;

// ── MCP Server ───────────────────────────────────────────
export const MCP_BASE_PATHS = env('MCP_BASE_PATHS')
  ? env('MCP_BASE_PATHS').split(',').map(p => p.trim()).filter(Boolean)
  : null; // null = let config.js use its own default

// ── Google Sheet 工具 ────────────────────────────────────
export const GSHEET_CREDENTIALS_PATH = env('GSHEET_CREDENTIALS_PATH');

// ── Hook: repetition-detector ────────────────────────────
export const CLAUDE_HOOK_DEBUG     = envBool('CLAUDE_HOOK_DEBUG');
export const CLAUDE_SLACK_WEBHOOK  = env('CLAUDE_SLACK_WEBHOOK');
export const CLAUDE_NOTIFY_ON_BLOCK = envBool('CLAUDE_NOTIFY_ON_BLOCK', true);
export const CLAUDE_TOKEN_FEEDBACK  = env('CLAUDE_TOKEN_FEEDBACK', 'passive');
export const CLAUDE_SUMMARY_INTERVAL = envInt('CLAUDE_SUMMARY_INTERVAL', 25);
