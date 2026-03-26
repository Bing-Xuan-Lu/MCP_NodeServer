/* Skills Tab 動態渲染 */

const CAT_COLORS = {
  'PHP 開發部':           '#22c55e',
  '測試品管部':           '#a855f7',
  '程式移植與規格分析部': '#06b6d4',
  '開發流程部':           '#0ea5e9',
  '部署維運部':           '#f59e0b',
  '資料庫規劃部':         '#3b82f6',
  '內容擷取部':           '#ec4899',
  '系統工具部':           '#94a3b8',
  'Claude 維運部':        '#8b5cf6',
  '研究開發部':           '#64748b',
  '生活自動化部':         '#64748b',
  '文書處理部':           '#64748b',
  'Docker 維運部':        '#64748b',
};

function renderSkillsTab() {
  const container = document.getElementById('skills-table-container');
  if (!container) return;

  const hotSkills  = Object.entries(SKILLS).filter(([, s]) => !s.cold);
  const coldSkills = Object.entries(SKILLS).filter(([, s]) => s.cold);

  // table rows
  const rows = hotSkills.map(([key, s]) => {
    const color = CAT_COLORS[s.dept] || '#94a3b8';
    const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}44;white-space:nowrap;">${s.dept}</span>`;
    return `<tr class="skill-row" data-search="${key} ${s.title} ${s.desc} ${s.dept}">
      <td style="padding:10px 12px;white-space:nowrap;"><a class="tag" href="javascript:void(0)" style="font-size:12px;">/${key}</a></td>
      <td style="padding:10px 12px;color:var(--text);font-size:13px;line-height:1.5;">${s.title}</td>
      <td style="padding:10px 12px;color:var(--muted);font-size:12px;line-height:1.5;max-width:320px;">${s.usage}</td>
      <td style="padding:10px 12px;">${badge}</td>
    </tr>`;
  }).join('');

  // cold groups
  const coldGroups = {};
  coldSkills.forEach(([key, s]) => {
    if (!coldGroups[s.dept]) coldGroups[s.dept] = [];
    coldGroups[s.dept].push(key);
  });
  const coldGroupsHtml = Object.entries(coldGroups).map(([dept, keys]) => `
    <div>
      <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">${dept}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;">${keys.map(k => `<a class="tag" href="javascript:void(0)" style="opacity:0.65;">/${k}</a>`).join('')}</div>
    </div>`).join('');

  container.innerHTML = `
    <section class="bento-item span-12" style="background:var(--surface);border:1px solid var(--border);padding:24px 28px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:16px;flex-wrap:wrap;">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;">
          Active Skills &nbsp;<span id="skillActiveCount">${hotSkills.length}</span> / 60
        </div>
        <input id="skillSearch" type="text" placeholder="搜尋 Skill 名稱、說明、部門..."
          style="font-family:var(--font-mono);font-size:13px;padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);width:260px;outline:none;">
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);">
              <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;">Skill</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">用途</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">指令範例</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;">類別</th>
            </tr>
          </thead>
          <tbody id="skillTableBody">${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="bento-item span-12" style="border:1px solid #334155;padding:0;margin-top:4px;">
      <details>
        <summary style="padding:16px 24px;cursor:pointer;font-family:var(--font-mono);font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;list-style:none;user-select:none;">
          ❄ 冷技能庫 (Cold Skills ${coldSkills.length}) — 不佔 60 個上限，需要時直接輸入指令名稱
        </summary>
        <div style="padding:4px 24px 20px;display:flex;flex-wrap:wrap;gap:16px 32px;">
          ${coldGroupsHtml}
        </div>
      </details>
    </section>`;

  // search
  document.getElementById('skillSearch')?.addEventListener('input', function() {
    const q = this.value.toLowerCase();
    document.querySelectorAll('#skillTableBody .skill-row').forEach(row => {
      row.style.display = row.dataset.search.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // re-bind tag clicks
  container.querySelectorAll('.tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const key = tag.textContent.trim().replace(/^\//, '');
      if (SKILLS[key]) openPanel(key, false);
    });
  });
}
