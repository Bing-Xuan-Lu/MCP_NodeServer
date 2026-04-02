#!/usr/bin/env node
/**
 * Skill Router — UserPromptSubmit Hook
 *
 * 根據 prompt 內容自動偵測相關 Skill 並注入建議。
 * 規則定義在 skill-keywords.json，輕量分數制：
 *   keyword 命中 = 2 分，pattern 命中 = 3 分，intent 命中 = 4 分
 * 達到 minScore 才輸出，最多顯示 maxSkillsToShow 個。
 *
 * 輸入（stdin JSON）：{ prompt: "..." }
 * 輸出（stdout）：注入 context 的文字，或靜默退出
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, 'skill-keywords.json');

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
  } catch {
    process.exit(0);
  }
}

function scoreSkill(skillName, skill, prompt, promptLower, scoring) {
  let score = 0;
  const reasons = [];

  for (const kw of skill.keywords || []) {
    if (promptLower.includes(kw.toLowerCase())) {
      score += scoring.keyword;
      reasons.push(`"${kw}"`);
    }
  }

  for (const pat of skill.patterns || []) {
    try {
      if (new RegExp(pat, 'i').test(prompt)) {
        score += scoring.pattern;
        reasons.push(`pattern`);
        break;
      }
    } catch {}
  }

  for (const intent of skill.intents || []) {
    if (promptLower.includes(intent.toLowerCase())) {
      score += scoring.intent;
      reasons.push(`intent`);
      break;
    }
  }

  return score > 0 ? { name: skillName, score, reasons: [...new Set(reasons)] } : null;
}

function evaluate(prompt) {
  const rules = loadRules();
  const { config, scoring, skills } = rules;
  const promptLower = prompt.toLowerCase();

  const matches = [];
  for (const [name, skill] of Object.entries(skills)) {
    const match = scoreSkill(name, skill, prompt, promptLower, scoring);
    if (match && match.score >= config.minScore) matches.push(match);
  }

  if (matches.length === 0) return '';

  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, config.maxSkillsToShow);

  let out = '<user-prompt-submit-hook>\n';
  out += '💡 偵測到可能相關的 Skill：\n\n';
  for (const m of top) {
    const confidence = m.score >= config.minScore * 2 ? '高' : '中';
    out += `  /${m.name}（相關度：${confidence}，命中：${m.reasons.slice(0, 2).join(', ')}）\n`;
  }
  out += '\n若符合需求，可先執行對應 Skill 再開始實作。\n';
  out += '</user-prompt-submit-hook>';

  return out;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || '';
    if (!prompt.trim()) process.exit(0);
    const output = evaluate(prompt);
    if (output) console.log(output);
  } catch {
    // 靜默失敗，不影響正常使用
  }
  process.exit(0);
});
