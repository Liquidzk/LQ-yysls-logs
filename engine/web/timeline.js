'use strict';
window.WireTimeline = (() => {
  const $ = id => document.getElementById(id)
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
  const fmt = v => v == null ? '未知' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  const clock = t => `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`
  const colors = ['#ad9bd3','#82b99d','#80accd','#d3ba71','#c68ea7','#82bbb5','#d49370']
  let report, names = {}, data, key, actor = '', from = 0, to = 1, ticket = 0, fetchStamp, chooseBattle
  let selected = new Set(), initialized = false, hoverPoints = []
  const person = id => report?.identities?.[id] || report?.actors?.find(a => a.idHash === id)?.name || (id ? '实体 · ' + id.slice(-6) : '来源未知')
  const buff = id => names.buffs?.[id] || `Buff #${id}`
  const skill = id => names.skills?.[id] || (id == null || Number(id) <= 0 ? '技能编号未下发' : `技能 #${id}`)
  const x = t => Math.max(0, Math.min(1000, (t - from) / Math.max(.001, to - from) * 1000))
  const color = id => colors[[...String(id)].reduce((s, c) => s + c.charCodeAt(0), 0) % colors.length]
  function ticks() { return Array.from({ length: 7 }, (_, i) => from + (to - from) * i / 6) }
  function grid(height) { return ticks().map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${height}" stroke="#354143" stroke-dasharray="2 5"/>`).join('') }
  function axis() { return '<div class="tl-lane tl-axis"><span></span><svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label="时间刻度">' + ticks().map((t,i)=>`<text x="${x(t)}" y="17" text-anchor="${i===0?'start':i===6?'end':'middle'}" fill="#94a8a6" font-size="12">${clock(t)}</text>`).join('') + '</svg><span></span></div>' }
  function detail(title, rows) {
    $('detail-content').textContent = title + '\n\n' + rows.join('\n\n')
    if (!$('detail-dialog').open) $('detail-dialog').showModal()
  }
  function init() {
    if (initialized) return; initialized = true
    $('tl-actor').onchange = () => { actor = $('tl-actor').value; render() }
    $('tl-window').onchange = () => { fetchStamp = null; show(report, names, chooseBattle).catch(error => { $('tl-state').textContent = error.message }) }
    $('tl-range').onclick = () => {
      const a = Number($('tl-from').value), b = Number($('tl-to').value)
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || a < 0 || b > data.duration + .1) { $('tl-state').textContent = '请输入全场范围内的起止时间'; return }
      from = a; to = Math.min(data.duration, b); render()
    }
    $('tl-reset').onclick = () => { from = 0; to = data.duration; render() }
    $('tl-buff-search').oninput = picker
    $('tl-buff-clear').onclick = () => { selected.clear(); picker(); buffLanes() }
    $('tl-action-kind').onchange = actionLanes
    $('tl-skill-search').oninput = actionLanes
    $('tl-dps').onmousemove = event => {
      if (!hoverPoints.length) return
      const bounds = $('tl-dps').getBoundingClientRect()
      const at = from + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (to - from)
      const point = hoverPoints.reduce((a,b) => Math.abs(a.t-at) < Math.abs(b.t-at) ? a : b)
      $('tl-readout').textContent = `${clock(point.t)} · 全队 ${fmt(point.team)}${actor ? ' · ' + person(actor) + ' ' + fmt(point.personal) : ''} DPS`
      const line = $('tl-cursor'); if (line) { line.setAttribute('x1', x(point.t)); line.setAttribute('x2', x(point.t)); line.style.opacity = '1' }
    }
    $('tl-dps').onmouseleave = () => { const line = $('tl-cursor'); if (line) line.style.opacity = '0' }
  }
  async function show(r, n, callback) {
    init(); report = r; names = n; chooseBattle = callback
    const stamp = `${r.key}/${r.end}/${r.counts?.counter}/${r.counts?.buff}/${r.counts?.action}/${r.indexing}/${$('tl-window').value}`
    if (fetchStamp === stamp && data) { render(); return }
    fetchStamp = stamp; const request = ++ticket
    $('tl-state').textContent = '正在读取整场时间线…'
    const response = await fetch('/api/capture/timeline?' + new URLSearchParams({ key: r.key, window: $('tl-window').value }))
    const result = await response.json()
    if (request !== ticket) return
    if (!response.ok) { fetchStamp = null; throw Error(result.error || '时间线读取失败') }
    if (result.requiresBattle) {
      data = null; $('tl-body').hidden = true; $('tl-pick').hidden = false; $('tl-state').textContent = ''
      $('tl-pick').innerHTML = '请选择一场战斗，以免把不同场次的曲线与覆盖率混在一起。<div class="tl-battle-choices">' + result.battles.map(b => `<button data-battle="${esc(b.key)}">${esc(new Date(b.startedAt).toLocaleString('zh-CN', {hour12:false}))}</button>`).join('') + (result.battles.length ? '' : '这份会话尚未记录到开战边界。') + '</div>'
      $('tl-pick').querySelectorAll('[data-battle]').forEach(b => { b.onclick = () => chooseBattle(b.dataset.battle) }); return
    }
    if (key !== r.key) {
      key = r.key; actor = ''; from = 0; to = result.duration; selected = new Set()
      const totals = new Map()
      const roster = new Set(r.actors.map(a => a.idHash))
      for (const lane of result.buffs) if (roster.has(lane.actor)) totals.set(lane.buffId, (totals.get(lane.buffId) || 0) + lane.coveredSeconds)
      selected = new Set([...totals].sort((a,b) => Number(!!names.buffs?.[b[0]]) - Number(!!names.buffs?.[a[0]]) || b[1]-a[1]).slice(0,6).map(([id]) => id))
    }
    data = result; $('tl-pick').hidden = true; $('tl-body').hidden = false
    render()
  }
  function render() {
    if (!data) return
    const actors = { ...report.identities, ...Object.fromEntries(report.actors.map(a => [a.idHash, a.name])) }
    $('tl-actor').innerHTML = '<option value="">全队</option>' + Object.entries(actors).map(([id,name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')
    if (actor && !actors[actor]) actor = ''
    $('tl-actor').value = actor
    to = Math.min(to || data.duration, data.duration); $('tl-from').value = from.toFixed(1); $('tl-to').value = to.toFixed(1)
    $('tl-state').textContent = data.indexing ? '正在补建索引，刷新后可看到余下记录' : `全场 ${clock(data.duration)}${data.serverDuration ? ' · 服务器结算 ' + clock(data.serverDuration) : ''}`
    $('tl-notice').textContent = data.notice
    drawDps(); picker(); buffLanes(); actionLanes()
  }
  function drawDps() {
    const curve = data.dps
    hoverPoints = curve.times.map((t,i) => ({t,team:curve.team[i],personal:curve.actors[actor]?.[i] ?? null})).filter(p => p.t >= from && p.t <= to)
    const peak = Math.max(1, ...hoverPoints.flatMap(p => [p.team || 0, actor ? p.personal || 0 : 0])) * 1.08
    const path = field => {
      let output = '', connected = false
      for (const p of hoverPoints) { if (p[field] == null) { connected=false; continue }; output += `${connected ? 'L' : 'M'}${x(p.t).toFixed(2)} ${(190-p[field]/peak*180).toFixed(2)} `; connected=true }
      return output
    }
    $('tl-dps').innerHTML = grid(195) + [0,.5,1].map(v => `<line x1="0" x2="1000" y1="${190-v*180}" y2="${190-v*180}" stroke="#354143"/><text x="6" y="${184-v*174}" fill="#94a8a6" font-size="12">${fmt(v*peak)}</text>`).join('') +
      `<path d="${path('team')}" fill="none" stroke="#8dc9b8" stroke-width="2.5"/>` + (actor ? `<path d="${path('personal')}" fill="none" stroke="#e4b67a" stroke-width="2.5"/>` : '') +
      ticks().map((t,i) => `<text x="${x(t)}" y="222" text-anchor="${i===0?'start':i===6?'end':'middle'}" fill="#94a8a6" font-size="12">${clock(t)}</text>`).join('') +
      '<line id="tl-cursor" x1="0" x2="0" y1="0" y2="195" stroke="#e5edeb" stroke-dasharray="3 3" opacity="0"/>' +
      (hoverPoints.some(p => p.team != null || p.personal != null) ? '' : '<text x="500" y="100" text-anchor="middle" fill="#94a8a6">该区间没有足够的连续统计快照</text>')
    $('tl-plot').title = curve.basis
  }
  function picker() {
    if (!data) return
    const query = $('tl-buff-search').value.trim().toLowerCase()
    const roster = new Set(report.actors.map(a => a.idHash))
    const ids = [...new Set(data.buffs.filter(l => actor ? l.actor === actor : roster.has(l.actor)).map(l => l.buffId))].sort((a,b) => buff(a).localeCompare(buff(b),'zh-CN'))
    const shown = ids.filter(id => `${buff(id)} ${id}`.toLowerCase().includes(query))
    $('tl-buff-options').innerHTML = shown.map(id => `<label class="tl-chip"><input type="checkbox" value="${esc(id)}" ${selected.has(id)?'checked':''}><span>${esc(buff(id))} <small>#${esc(id)}</small></span></label>`).join('') || '<span class="muted">没有匹配的 Buff</span>'
    $('tl-buff-options').querySelectorAll('input').forEach(input => { input.onchange = () => { input.checked ? selected.add(input.value) : selected.delete(input.value); buffLanes() } })
  }
  function buffLanes() {
    if (!data) return
    const roster = new Set(report.actors.map(a => a.idHash))
    const lanes = data.buffs.filter(l => selected.has(l.buffId) && (actor ? l.actor === actor : roster.has(l.actor)))
    lanes.sort((a,b) => buff(a.buffId).localeCompare(buff(b.buffId),'zh-CN') || person(a.actor).localeCompare(person(b.actor),'zh-CN'))
    $('tl-buffs').innerHTML = axis() + (lanes.map((lane,index) => {
      const coverage = lane.union.reduce((sum,[a,b]) => sum + Math.max(0,Math.min(to,b)-Math.max(from,a)),0) / Math.max(.001,to-from)
      const intervals = lane.intervals.filter(i => i.end > from && i.start < to)
      const rects = intervals.map((v,i) => {
        const title = `${buff(lane.buffId)} #${lane.buffId}\n${person(lane.actor)} ← ${person(v.source)}\n${clock(v.start)} — ${clock(v.end)} · 层数 ${v.stacks ?? '未知'}\n${v.leftUnknown?'开始前状态不完整；':''}${v.rightUnknown?'结束点未观测到；':''}${v.visibility}`
        return `<g data-interval="${i}" tabindex="0" role="button" aria-label="${esc(title)}"><rect x="${x(v.start)}" y="4" width="${Math.max(.8,x(v.end)-x(v.start))}" height="22" fill="${color(lane.buffId)}"/><rect x="${x(v.start)}" y="4" width="${Math.max(.8,x(v.end)-x(v.start))}" height="22" fill="${v.leftUnknown||v.rightUnknown?'url(#hatch-'+index+')':'transparent'}"/><title>${esc(title)}</title></g>`
      }).join('')
      return `<div class="tl-lane" data-buff-lane="${index}"><div class="tl-lane-name" title="${esc(buff(lane.buffId)+' #'+lane.buffId)}"><b style="color:${color(lane.buffId)}">${esc(buff(lane.buffId))}</b><small>${esc(person(lane.actor))}</small></div><svg viewBox="0 0 1000 30" preserveAspectRatio="none" aria-label="${esc(buff(lane.buffId))} 覆盖"><defs><pattern id="hatch-${index}" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 10L10 0" stroke="#101719" stroke-width="3" opacity=".35"/></pattern></defs>${grid(30)}${rects}</svg><span class="tl-percent" title="当前所选时间范围的观测覆盖；重叠实例只计算一次">${(coverage*100).toFixed(1)}%</span></div>`
    }).join('') || '<p class="tl-empty">请选择 Buff；没有观测记录不能视为零覆盖。</p>')
    $('tl-buffs').querySelectorAll('[data-buff-lane]').forEach(row => {
      const lane=lanes[Number(row.dataset.buffLane)], intervals=lane.intervals.filter(i=>i.end>from&&i.start<to)
      row.querySelectorAll('[data-interval]').forEach(el => {
        const open=()=>{const v=intervals[Number(el.dataset.interval)];detail(`${buff(lane.buffId)} #${lane.buffId}`, [`${person(lane.actor)} ← ${person(v.source)}`,`${clock(v.start)} — ${clock(v.end)} · 层数 ${v.stacks ?? '未知'}`,v.leftUnknown||v.rightUnknown?'这是起止不完整的观测区间，条纹不是已确认的完整覆盖。':'添加与移除通知之间的观测区间。'])}
        el.onclick=open;el.onkeydown=e=>{if(e.key==='Enter')open()}
      })
    })
  }
  function actionLanes() {
    if (!data) return
    const mode=$('tl-action-kind').value, query=$('tl-skill-search').value.trim().toLowerCase()
    const roster=actor?[actor]:report.actors.map(a=>a.idHash)
    const events=data.actions.filter(e=>roster.includes(e.actor)&&e.t>=from&&e.t<=to&&(mode==='all'||(mode==='hit'?e.kind==='hit':e.kind!=='hit'))&&`${skill(e.skillId)} ${e.skillId}`.toLowerCase().includes(query))
    const labels={cast:'技能开始',end:'技能结束',segment:'技能分段',snapshot:'入场时技能快照',hit:'命中／治疗通知'}
    const describe=e=>`${clock(e.t)} · ${labels[e.kind]||e.kind} · ${skill(e.skillId)} #${e.skillId ?? '未记录'}\n${person(e.actor)} → ${person(e.target)}${e.amount!=null?' · 数值 '+fmt(e.amount):''}${e.segment!=null?' · 第 '+e.segment+' 段':''}`
    $('tl-action-count').textContent=`当前范围 ${events.length.toLocaleString()} 条动作／通知`
    $('tl-actions-note').textContent=data.actions.some(e=>e.kind==='cast')?'施放按服务器同步记录；多段命中分别保留。没有动作通知的技能无法补出起手时间。':'这份旧记录仅保存命中通知，未保存技能起手。新版开始采集后会同时保存服务器同步的开始、结束及分段；旧记录不会把命中猜成施放。'
    $('tl-actions').innerHTML=axis() + (roster.map((id,index)=>{
      const rows=events.filter(e=>e.actor===id)
      const marks=rows.map((e,i)=>{
        const cx=x(e.t), cy=12+(i%4)*12, title=esc(describe(e))
        const shape=e.kind==='hit'?`<circle cx="${cx}" cy="${cy}" r="3.2" fill="${color(e.skillId)}"/>`:e.kind==='segment'?`<path d="M${cx-3} ${cy-4}l7 4 -7 4Z" fill="none" stroke="${color(e.skillId)}"/>`:e.kind==='snapshot'?`<rect x="${cx-3}" y="${cy-3}" width="6" height="6" fill="none" stroke="#94a8a6"/>`:`<path d="M${cx} ${cy-4}l4 4 -4 4 -4 -4Z" fill="${e.kind==='end'?'none':color(e.skillId)}" stroke="${color(e.skillId)}"/>`
        return `<g data-action="${i}" role="button" tabindex="0" aria-label="${title}">${shape}<title>${title}</title></g>`
      }).join('')
      return `<div class="tl-lane" data-action-lane="${index}"><div class="tl-lane-name"><b>${esc(person(id))}</b><small>${rows.length} 条</small></div><svg viewBox="0 0 1000 62" preserveAspectRatio="none" aria-label="${esc(person(id))} 动作时间线">${grid(62)}${marks}</svg><span class="tl-percent">${rows.length?'':'未观测'}</span></div>`
    }).join('') || '<p class="tl-empty">没有可显示的角色。</p>')
    $('tl-actions').querySelectorAll('[data-action-lane]').forEach(lane=>{
      const id=roster[Number(lane.dataset.actionLane)],rows=events.filter(e=>e.actor===id)
      const open=at=>detail(`${person(id)} · ${clock(at)} 附近的全部动作`,rows.filter(e=>Math.abs(e.t-at)<.3).map(describe))
      lane.querySelector('svg').onclick=e=>{const el=e.target.closest('[data-action]');if(el)open(rows[Number(el.dataset.action)].t);else{const b=e.currentTarget.getBoundingClientRect();open(from+(e.clientX-b.left)/b.width*(to-from))}}
      lane.querySelectorAll('[data-action]').forEach(el=>{el.onkeydown=e=>{if(e.key==='Enter')open(rows[Number(el.dataset.action)].t)}})
    })
  }
  return { show }
})()
