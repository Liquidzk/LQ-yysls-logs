'use strict'
const $ = id => document.getElementById(id), desktop = window.yanyunDesktop
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—'
const clock = value => typeof value === 'number' ? Math.floor(value / 60).toString().padStart(2, '0') + ':' + (value % 60).toFixed(1).padStart(4, '0') : '—'
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间待记录'
const state = { mode: 'live', tab: 'team', processes: [], sessions: [], key: null, report: null, offset: 0, actor: '', kind: 'all', search: '', busy: false, serial: 0, names: {} }
let toastTimer
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true }, 6500) }
async function api(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw Error(data.error || '读取失败'); return data }
function player(id) { return state.report?.identities[id] || state.report?.actors.find(a => a.idHash === id)?.name || (id ? '实体 · ' + id.slice(-6) : '未知') }
function skill(id) { return id == null || id === '' ? '技能未记录' : state.names.skills?.[String(id)] || '技能 #' + id }
function buff(id) { return id == null ? 'Buff 未记录' : state.names.buffs?.[String(id)] || 'Buff #' + id }
function title(s) { return s?.npcTemplateNo && state.names.npcs?.[String(s.npcTemplateNo)] ? (s.kind === 'battle' ? '战斗 · ' : '采集会话 · ') + state.names.npcs[String(s.npcTemplateNo)] : s?.title || '当前采集会话' }
function mode(value) { state.serial++; state.mode = value; $('binding-panel').hidden = value !== 'live'; document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === value)) }
document.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { mode(b.dataset.mode); refresh().catch(e => toast(e.message)) } })
async function processes() {
  if (!desktop) { toast('请在独立客户端中选择进程'); return }
  $('refresh-process').disabled = true
  try {
    state.processes = await desktop.listProcesses()
    $('process').innerHTML = '<option value="">' + (state.processes.length ? '请选择要绑定的游戏进程' : '未找到游戏，请先启动游戏后刷新') + '</option>' + state.processes.map((p, i) => `<option value="${i}" ${p.accessible ? '' : 'disabled'}>${esc(p.title || p.name)} · PID ${p.pid}${p.accessible ? '' : '（无读取权限）'} · ${esc(p.path)}</option>`).join('')
    $('start').disabled = true
  } finally { $('refresh-process').disabled = false }
}
$('refresh-process').onclick = () => processes().catch(e => toast(e.message))
$('process').onchange = () => { $('start').disabled = !$('process').value || $('stop').disabled === false }
$('start').onclick = async () => {
  const selected = state.processes[Number($('process').value)]
  if ($('process').value === '' || !selected) return
  $('start').disabled = true
  try { await desktop.startCapture({ pid: selected.pid, startedAt: selected.startedAt }); mode('live'); await refresh(); toast('已绑定所选进程，正在初始化采集') }
  catch (e) { toast(e.message); $('start').disabled = false }
}
$('stop').onclick = async () => { $('stop').disabled = true; try { await desktop.stopCapture(); await refresh(); toast('采集已停止，记录已保留') } catch (e) { toast(e.message) } }
$('overlay').onclick = () => desktop?.showKagerou('live').catch(e => toast(e.message))
$('open-folder').onclick = () => desktop?.openCaptureFolder()
$('import').onclick = async () => { try { const r = await desktop?.importCapture(); if (r && !r.canceled) { mode('archive'); await list(); toast('已添加捕获目录，点击左侧记录开始解析') } } catch (e) { toast(e.message) } }
$('refresh-records').onclick = () => list().catch(e => toast(e.message))
async function list() {
  state.sessions = await api('/api/capture/sessions')
  state.sessions.forEach(s => { s.title = title(s) })
  $('session-list').innerHTML = state.sessions.map(s => `<button class="session ${state.key === s.key ? 'active' : ''}" data-key="${s.key}"><b>${esc(s.title)}</b><small>${esc(date(s.startedAt))}</small><small>${s.kind === 'battle' ? '已分段战斗' : '包含全部观测'} · ${s.mode === 'replay' ? '历史回放' : '捕获记录'}</small></button>`).join('') || '<p class="empty-small">暂无捕获记录。开始采集或解析已有捕获目录。</p>'
  document.querySelectorAll('[data-key]').forEach(b => { b.onclick = () => { state.key = b.dataset.key; state.offset = 0; mode('archive'); load().catch(e => toast(e.message)); list().catch(() => {}) } })
}
async function load() {
  if (!state.key) return
  const serial = ++state.serial
  const q = new URLSearchParams({ key: state.key, actor: state.actor, kind: state.kind, offset: state.offset, search: state.search })
  const report = await api('/api/capture/report?' + q)
  if (serial !== state.serial) return
  state.report = report; render()
}
function render() {
  const r = state.report; if (!r) return
  document.querySelector('.chart-panel').hidden = state.tab === 'timeline'
  if (state.tab === 'timeline') window.WireTimeline.show(r, state.names, key => { state.key = key; mode('archive'); load().catch(e => toast(e.message)); list().catch(() => {}) }).catch(e => toast(e.message))
  $('empty').hidden = true; $('review').hidden = false
  $('source-label').textContent = state.mode === 'live' ? (state.running ? '当前采集 · 已观测数据' : '采集已停止 · 末次记录') : '已保存的网络观测'
  $('fight-title').textContent = state.sessions.find(s => s.key === r.key)?.title || '当前采集会话'
  $('fight-time').textContent = date(r.start * 1000) + ' — ' + date(r.end * 1000)
  $('duration').textContent = clock(r.duration)
  $('notice').textContent = r.notice + (r.indexing ? ' 正在建立索引，继续刷新可加载剩余记录。' : '') + (r.skippedRows ? ` 有 ${r.skippedRows} 行格式异常。` : '')
  $('damage').textContent = r.actors.length ? num(r.actors.reduce((sum, a) => sum + a.damage, 0)) : '—'
  $('players').textContent = r.actors.length; $('hits').textContent = num(r.counts.hit || 0); $('buffs').textContent = num(r.counts.buff || 0)
  const max = Math.max(1, ...r.actors.map(a => a.damage || 0))
  $('team-table').innerHTML = [...r.actors].sort((a, b) => b.damage - a.damage).map(a => `<tr><td class="bar-name">${esc(a.name)}<i style="width:${Math.max(0, a.damage / max * 85)}%"></i></td><td class="numeric">${num(a.damage)}</td><td class="numeric">${r.duration > 0 ? num(a.damage / r.duration) : '—'}</td><td class="numeric">${num(a.heal)}</td></tr>`).join('') || '<tr><td colspan="4">尚未收到服务器队伍统计；这不表示实际输出为零。</td></tr>'
  const skillRows = []
  for (const detail of r.settlements) for (const a of detail.actors || []) for (const target of a.targets || []) for (const [kind, category] of Object.entries(target.categories)) for (const s of category.skills || []) {
    skillRows.push(`<tr><td>${esc(player(a.actorHash))}</td><td>${esc(player(target.targetActorHash))}</td><td>${esc(skill(s.skillId))}</td><td>${esc({ damage: '伤害', heal: '治疗', absorb_dmg: '承伤字段' }[kind] || kind)}</td><td class="numeric">${num(s.amount)}</td></tr>`)
  }
  $('skills-table').innerHTML = skillRows.join('') || '<tr><td colspan="5">尚未取得该场战斗的服务器技能结算。</td></tr>'
  $('observed-skills-table').innerHTML = (r.observedSkills || []).map((s, i) => `<tr class="event" data-skill-row="${i}"><td>${esc(player(s.sourceActorHash))} → ${esc(player(s.targetActorHash))}</td><td>${esc(skill(s.skillId))}</td><td class="numeric">${num(s.notificationCount)}</td><td class="numeric">${num(s.amount)}${s.measuredCount < s.notificationCount ? '（部分）' : ''}</td><td class="numeric">${r.duration > 0 && s.amount != null ? num(s.amount / r.duration) : '—'}</td><td>${clock(s.first)} / ${clock(s.last)}</td></tr>`).join('') || '<tr><td colspan="6">尚未收到该范围内的技能命中通知；无需等到战斗结算。</td></tr>'
  document.querySelectorAll('[data-skill-row]').forEach(el => { el.onclick = () => {
    const s = r.observedSkills[Number(el.dataset.skillRow)]
    state.search = s.skillId; state.actor = s.sourceActorHash || ''; state.kind = 'hit'; state.offset = 0
    $('event-search').value = state.search; $('kind-filter').value = 'hit'
    selectTab('events', true)
  } })
  const actors = { ...r.identities, ...Object.fromEntries(r.actors.map(a => [a.idHash, a.name])) }
  $('actor-filter').innerHTML = '<option value="">全部角色</option>' + Object.entries(actors).map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')
  $('actor-filter').value = state.actor
  const labels = { hit: '受击／治疗通知', buff: 'Buff 观测', action: '技能动作', boundary: '战斗／目标状态', settlement: '服务器结算' }
  $('events-table').innerHTML = r.events.map((e, i) => {
    const d = e.data
    const content = e.kind === 'action' ? `${skill(d.rawSkillId)} · ${{cast:'技能开始',end:'技能结束',segment:'技能分段'}[d.actionKind] || d.actionKind}` : e.kind === 'hit' ? `${skill(d.rawSkillId)} · 通知数值 ${num(d.amount)}` : e.kind === 'buff' ? `${buff(d.buffNo)} · ${{ apply_candidate: '添加候选', update: '更新', snapshot: '初始快照', remove_candidate: '移除候选', field_patch: '属性变化' }[d.kind] || d.kind} · 层数 ${d.charge_level ?? d.level ?? '未知'}` : d.kind || '结算详情'
    return `<tr class="event" data-event="${i}"><td>${clock(e.t)}</td><td>${esc(labels[e.kind] || e.kind)}</td><td>${esc(d.sourceActorName || player(d.sourceActorHash))} → ${esc(d.targetActorName || player(d.targetActorHash))}</td><td>${esc(content)}</td></tr>`
  }).join('') || '<tr><td colspan="4">没有匹配的观测记录。</td></tr>'
  document.querySelectorAll('[data-event]').forEach(el => { el.onclick = () => { $('detail-content').textContent = JSON.stringify(r.events[Number(el.dataset.event)], null, 2); $('detail-dialog').showModal() } })
  $('page').textContent = `${num(r.totalEvents)} 条记录 · 第 ${Math.floor(r.offset / 100) + 1} 页`
  $('previous').disabled = r.offset === 0; $('next').disabled = r.offset + 100 >= r.totalEvents
  const points = r.points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.damage)), end = Math.max(1, ...points.map(p => p.t)), peak = Math.max(1, ...points.map(p => p.damage))
  const coords = points.map(p => `${15 + p.t / end * 870},${125 - p.damage / peak * 110}`).join(' ')
  $('chart').innerHTML = '<path d="M15 125H885 M15 70H885 M15 15H885" stroke="#314344" stroke-width="1"/>' + (points.length ? `<polyline points="${coords}" fill="none" stroke="#aaca89" stroke-width="2.5"/><text x="15" y="148" fill="#91a9a4" font-size="11">00:00</text><text x="830" y="148" fill="#91a9a4" font-size="11">${clock(end)}</text>` : '<text x="340" y="75" fill="#91a9a4" font-size="14">等待服务器统计快照</text>')
}
function selectTab(tab, keepFilter = false) {
  state.tab = tab
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('selected', b.dataset.tab === tab))
  for (const name of ['team', 'skills', 'events', 'timeline']) $(name + '-panel').hidden = name !== (tab === 'buffs' ? 'events' : tab)
  if (!keepFilter) { state.kind = tab === 'buffs' ? 'buff' : 'all'; state.search = ''; state.actor = ''; $('event-search').value = ''; $('kind-filter').value = state.kind; state.offset = 0 }
  load().catch(e => toast(e.message))
}
document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => selectTab(b.dataset.tab) })
$('search').onclick = () => { state.kind = $('kind-filter').value; state.actor = $('actor-filter').value; state.search = $('event-search').value.trim(); state.offset = 0; load().catch(e => toast(e.message)) }
$('previous').onclick = () => { state.offset = Math.max(0, state.offset - 100); load().catch(e => toast(e.message)) }
$('next').onclick = () => { state.offset += 100; load().catch(e => toast(e.message)) }
$('close-detail').onclick = () => $('detail-dialog').close()
async function refresh() {
  if (state.busy) return
  state.busy = true
  try {
    const data = await api('/api/capture/status'), running = data.control.running
    state.running = !!running
    $('status').textContent = running ? data.service.message || '正在启动采集' : '采集未运行'
    $('status-detail').textContent = running ? data.service.detail || (data.control.binding ? '绑定 PID ' + data.control.binding.pid : '') : '手动选择进程后开始；历史记录已保留'
    $('status-dot').classList.toggle('active', !!running && data.health.session === 'valid' && !data.health.stale)
    $('stop').disabled = !running; $('start').disabled = !!running || $('process').value === ''; $('process').disabled = !!running
    if (state.mode === 'live' && data.key) { state.key = data.key; await load() }
    else if (state.mode === 'live') { state.serial++; state.key = null; state.report = null; $('empty').hidden = false; $('review').hidden = true }
  } finally { state.busy = false }
}
api('/api/names').then(names => { state.names = names; render() }).catch(() => {})
list().catch(e => toast(e.message)); refresh().catch(e => toast(e.message))
setInterval(() => refresh().catch(() => { $('status').textContent = '解析服务连接中断' }), 2000)
setInterval(() => list().catch(() => {}), 10000)

let nameCatalog
function renderNames() {
  if (!nameCatalog) return
  const kind = $('names-kind').value, query = $('names-search').value.trim().toLowerCase(), filter = $('names-status').value
  const mapped = state.names[kind] || {}, unresolved = nameCatalog.unresolved?.[kind] || {}, evidence = nameCatalog.provenance?.[kind] || {}
  const ids = [...new Set([...Object.keys(mapped), ...Object.keys(unresolved)])].filter(id => {
    const status = mapped[id] ? 'mapped' : unresolved[id]?.status
    return (filter === 'all' || status === filter) && `${id} ${mapped[id] || ''}`.toLowerCase().includes(query)
  }).sort((a,b) => Number(a) - Number(b))
  $('names-rows').innerHTML = ids.slice(0,200).map(id => `<tr><td>${esc(id)}</td><td>${esc(mapped[id] || unresolved[id]?.reason || '待恢复')}</td><td>${esc(evidence[id] ? `${evidence[id].label} · ${evidence[id].table}.${evidence[id].field}${evidence[id].via ? ' → ' + evidence[id].via : ''}` : unresolved[id]?.status || '')}</td></tr>`).join('') || '<tr><td colspan="3">没有匹配的条目。</td></tr>'
  $('names-summary').textContent = `当前类别已映射 ${Object.keys(mapped).length.toLocaleString()} 条。保留原编号；内部未命名条目与尚未恢复的文本分别列出。`
  $('names-count').textContent = `匹配 ${ids.length.toLocaleString()} 条，显示前 ${Math.min(ids.length,200)} 条；输入名称或编号缩小范围。`
}
$('show-names').onclick = async () => { $('names-dialog').showModal(); $('names-summary').textContent = '正在读取名称来源…'; try { nameCatalog ||= await api('/api/name-catalog'); renderNames() } catch(e) { $('names-summary').textContent = e.message } }
$('close-names').onclick = () => $('names-dialog').close()
for (const id of ['names-kind','names-status']) $(id).onchange = renderNames
$('names-search').oninput = renderNames
