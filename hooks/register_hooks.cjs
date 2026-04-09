/**
 * register_hooks.js
 * 將標準 hook 登記到 ~/.claude/settings.json
 * 用法：node hooks/register_hooks.js
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const settingsPath = path.join(HOME, '.claude', 'settings.json');
const hooksDir = path.join(HOME, '.claude', 'hooks').split(path.sep).join('/');

const REQUIRED_HOOKS = {
  SessionStart: [
    { command: `node "${hooksDir}/session-start.js"` },
  ],
  PreCompact: [
    { command: `node "${hooksDir}/pre-compact.js"` },
  ],
  PreToolUse: [
    { matcher: '.*',          command: `node "${hooksDir}/repetition-detector.js"` },
    { matcher: 'Write|Edit',  command: `node "${hooksDir}/write-guard.js"` },
    { matcher: '.*',          command: `node "${hooksDir}/user-prompt-guard.js"` },
    { matcher: '.*',          command: `node "${hooksDir}/skill-router.js"` },
  ],
  PostToolUse: [
    { matcher: 'Write|Edit',  command: `node "${hooksDir}/llm-judge.js"` },
  ],
  Stop: [
    { command: `node "${hooksDir}/session-stop.js"` },
  ],
};

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
} catch (e) {
  // settings.json 不存在或無法解析，從空物件開始
}
if (!settings.hooks) settings.hooks = {};

function commandExists(hookList, cmd) {
  if (!Array.isArray(hookList)) return false;
  return hookList.some(entry =>
    (entry.hooks || []).some(h => h.command === cmd)
  );
}

let changed = 0;
for (const [event, entries] of Object.entries(REQUIRED_HOOKS)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  for (const entry of entries) {
    if (!commandExists(settings.hooks[event], entry.command)) {
      const hookEntry = { hooks: [{ type: 'command', command: entry.command }] };
      if (entry.matcher) hookEntry.matcher = entry.matcher;
      settings.hooks[event].push(hookEntry);
      changed++;
      const label = path.basename(entry.command.replace(/^node\s+"?/, '').replace(/"$/, ''));
      console.log(`[登記] ${event}${entry.matcher ? ` (${entry.matcher})` : ''}: ${label}`);
    }
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
if (changed === 0) console.log('[Hook] 所有 hook 均已登記，無需更新');
else console.log(`[Hook] 已自動登記 ${changed} 個 hook`);
