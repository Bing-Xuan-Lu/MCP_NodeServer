/* App — panel、tab 切換、theme、初始化 */

const panel        = document.getElementById('skillPanel');
const panelOverlay = document.getElementById('panelOverlay');
const panelCmd     = document.getElementById('panelSkillCmd');
const panelDept    = document.getElementById('panelDept');
const panelTitle   = document.getElementById('panelTitle');
const panelDesc    = document.getElementById('panelDesc');
const panelUsage   = document.getElementById('panelUsage');
const panelTools   = document.getElementById('panelTools');

function openPanel(key, isTool = false) {
  const d = isTool ? TOOLS[key] : SKILLS[key];
  if (!d) return;

  panelCmd.textContent   = isTool ? 'Tool: ' + key : '/' + key;
  if(panelDept) panelDept.textContent  = d.dept;
  if(panelTitle) panelTitle.textContent = d.title;
  if(panelDesc) panelDesc.textContent  = d.desc;
  if(panelUsage) panelUsage.textContent = d.usage;

  if(panelTools) {
    panelTools.innerHTML = d.tools && d.tools.length
      ? d.tools.map(t => `<span class="panel-tool-tag">${t}</span>`).join('')
      : '<span class="panel-no-tools">不需要 MCP 工具</span>';
  }

  panel.classList.add('open');
  if(panelOverlay) panelOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  panel.classList.remove('open');
  if(panelOverlay) panelOverlay.classList.remove('active');
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', function() {

  // 1. 渲染 Skills tab
  renderSkillsTab();

  // 2. Auto-count stats
  const allSkills = Object.values(SKILLS);
  const hotSkills = allSkills.filter(s => !s.cold);
  const coldSkills = allSkills.filter(s => s.cold);
  const toolCount = Object.keys(TOOLS).length;
  ['heroSkillCount','statSkills'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = hotSkills.length + ' / 60';
  });
  ['statColdSkills'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = coldSkills.length;
  });
  ['heroToolCount','statTools'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = toolCount;
  });

  // 3. Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).style.display = 'contents';
    });
  });

  // 4. Workflow sub-tab switching
  document.querySelectorAll('.wf-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wf-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.wf-panel').forEach(p => p.style.display = 'none');
      btn.classList.add('active');
      document.getElementById('wf-' + btn.dataset.wf).style.display = 'contents';
    });
  });

  // 5. Deep-link ?tab=xxx
  const urlTab = new URLSearchParams(location.search).get('tab');
  if (urlTab) {
    const target = document.querySelector(`.tab-btn[data-tab="${urlTab}"]`);
    if (target) target.click();
  }

  // 6. Theme toggle
  const themeBtn = document.getElementById('themeToggle');
  const html = document.documentElement;
  if (themeBtn) {
    themeBtn.textContent = html.getAttribute('data-theme') === 'light' ? '🌙' : '☀️';
    themeBtn.addEventListener('click', () => {
      const newTheme = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      themeBtn.textContent = newTheme === 'light' ? '🌙' : '☀️';
    });
  }

  // 7. tool-tag clicks（Tools tab）
  document.querySelectorAll('.tool-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const key = tag.textContent.trim();
      if (TOOLS[key]) openPanel(key, true);
    });
  });

  // 8. Panel close
  document.getElementById('closePanel')?.addEventListener('click', closePanel);
  document.getElementById('panelOverlay')?.addEventListener('click', closePanel);
  
  // ESC key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closePanel();
  });
});
