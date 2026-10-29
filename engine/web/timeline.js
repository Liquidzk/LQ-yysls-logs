'use strict';
window.WireTimeline = (() => {
  const $ = id => document.getElementById(id)
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
  const fmt = v => v == null ? '未知' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  const clock = t => `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`
  const colors = ['#ad9bd3','#82b99d','#80accd','#d3ba71','#c68ea7','#82bbb5','#d49370']
  let report, names = {}, data, key, actor = '', from = 0, to = 1, ticket = 0, fetchStamp, chooseBattle
  const storageKey = 'yanyun-timeline-layout-v1'
  let layout, candidates = [], pickerKind = 'player-buff', dragKey = '', groupPending = false
  let initialized = false, hoverPoints = [], orderPage = 0
  const party = () => [...new Set([...(report?.actors || []).map(a => a.idHash), ...Object.keys(data?.dps?.actors || {})])]
  const laneId = TimelineLayout.id
  function savedLayouts() {
    try { const rows = JSON.parse(localStorage.getItem(storageKey)); return Array.isArray(rows) ? rows.filter(r => r && typeof r.key === 'string' && r.state) : [] } catch { return [] }
  }
  function saveLayout(message = '布局已自动保存') {
    const rows = [{ key, state: layout.snapshot() }, ...savedLayouts().filter(r => r.key !== key)].slice(0, 15)
    while (rows.length > 1 && JSON.stringify(rows).length > 900000) rows.pop()
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); $('tl-layout-status').textContent = message }
    catch { $('tl-layout-status').textContent = '本机存储已满，本次布局暂未保存' }
  }
  function updateCandidates() {
    const players = new Set(party()), bosses = new Set((data.bossTargets || []).map(r => r.actorHash))
    const effects = data.buffs.filter(l => players.has(l.actor) || bosses.has(l.actor)).map(lane => {
      const type = bosses.has(lane.actor) ? 'boss-buff' : 'player-buff'
      return { id: laneId(type, lane.actor, lane.buffId), type, actor: lane.actor, buffId: lane.buffId, lane }
    }).sort((a,b) => buff(a.buffId).localeCompare(buff(b.buffId), 'zh-CN') || person(a.actor).localeCompare(person(b.actor), 'zh-CN'))
    candidates = [...effects, ...party().map(actor => ({ id: laneId('action', actor), type: 'action', actor }))]
    if (layout.reconcile(candidates)) saveLayout()
  }
  function trackLabel(row) { return row.type === 'action' ? person(row.actor) + ' · 动作' : buff(row.buffId) + ' · ' + person(row.actor) }
  function groupChanged() { saveLayout(); picker(); renderGroup() }
  function detailRoster() { return party().filter(id => layout.detailPlayers === null || layout.detailPlayers.includes(id)) }

  const bossName = r => r.group === 'choulingke' ? '愁铃客 · ' + (r.role === 'body' ? '肉体' : '灵魂') : names.npcs?.[String(r.npcTemplateNo)] || 'Boss #' + r.npcTemplateNo
  const person = id => data?.bossTargets?.find(r => r.actorHash === id) ? bossName(data.bossTargets.find(r => r.actorHash === id)) : report?.identities?.[id] || report?.actors?.find(a => a.idHash === id)?.name || (id ? '实体 · ' + id.slice(-6) : '来源未知')
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
    document.querySelectorAll('[data-track-kind]').forEach(button => { button.onclick = () => {
      pickerKind = button.dataset.trackKind; $('tl-track-target').value = ''; picker()
    } })
    $('tl-track-target').onchange = picker
    $('tl-track-search').oninput = picker
    $('tl-track-check').onclick = () => { filteredCandidates().forEach(row => layout.set(row.id, true)); groupChanged() }
    $('tl-track-uncheck').onclick = () => { filteredCandidates().forEach(row => layout.set(row.id, false)); groupChanged() }
    $('tl-group-clear').onclick = () => { layout.clear(); groupChanged() }
    $('tl-group-defaults').onclick = () => { layout.reset(candidates); groupChanged() }
    $('tl-action-kind').onchange = renderGroup
    $('tl-skill-search').oninput = renderGroup
    $('tl-order-skill-search').oninput = () => { orderPage = 0; actionSequence() }
    $('tl-order-all').onclick = () => { layout.detailPlayers = null; saveLayout(); detailPlayers(); orderPage = 0; actionSequence() }
    $('tl-order-none').onclick = () => { layout.detailPlayers = []; saveLayout(); detailPlayers(); orderPage = 0; actionSequence() }
    $('tl-order-kind').onchange = () => { orderPage=0; actionSequence() }
    $('tl-gap-min').oninput = () => { orderPage=0; actionSequence() }
    $('tl-order-prev').onclick = () => { orderPage--; actionSequence() }
    $('tl-order-next').onclick = () => { orderPage++; actionSequence() }
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
      key = r.key; actor = ''; from = 0; to = result.duration; orderPage = 0
      layout = new TimelineLayout.Layout(savedLayouts().find(row => row.key === key)?.state)
      pickerKind = 'player-buff'; $('tl-track-target').value = ''; $('tl-track-search').value = ''
      $('tl-skill-search').value = ''; $('tl-order-skill-search').value = ''
      dragKey = ''; groupPending = false
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
    updateCandidates(); drawDps(); picker(); renderGroup(); detailPlayers(); actionSequence()
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
  function filteredCandidates() {
    const target = $('tl-track-target').value, query = $('tl-track-search').value.trim().toLowerCase()
    return candidates.filter(row => row.type === pickerKind && (!target || row.actor === target) &&
      `${trackLabel(row)} ${row.buffId || ''}`.toLowerCase().includes(query))
  }
  function picker() {
    if (!data) return
    const target = $('tl-track-target').value, ids = [...new Set(candidates.filter(r => r.type === pickerKind).map(r => r.actor))]
    $('tl-track-target').innerHTML = '<option value="">全部</option>' + ids.map(id => `<option value="${esc(id)}">${esc(person(id))}</option>`).join('')
    $('tl-track-target').value = ids.includes(target) ? target : ''
    document.querySelectorAll('[data-track-kind]').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.trackKind === pickerKind))
      const title = { 'player-buff': '队员 Buff', 'boss-buff': 'Boss Buff／Debuff', action: '玩家动作' }[b.dataset.trackKind]
      b.textContent = `${title} (${layout.selected(candidates).filter(r => r.type === b.dataset.trackKind).length})`
    })
    const shown = filteredCandidates()
    $('tl-track-options').innerHTML = shown.map(row => `<label class="tl-chip"><input type="checkbox" value="${esc(row.id)}" ${layout.order.includes(row.id) ? 'checked' : ''}><span>${esc(row.type === 'action' ? person(row.actor) : buff(row.buffId))}<small>${row.type === 'action' ? '动作时间线' : esc(person(row.actor) + ' · #' + row.buffId)}</small></span></label>`).join('') ||
      '<p class="muted">没有匹配的观测记录；未观测到不表示没有。</p>'
    $('tl-track-options').querySelectorAll('input').forEach(input => { input.onchange = () => {
      layout.set(input.value, input.checked); saveLayout(); renderGroup()
      // Keep keyboard focus on the current checkbox while updating the tab counts.
      document.querySelectorAll('[data-track-kind]').forEach(b => { b.textContent = b.textContent.replace(/\(\d+\)$/, '(' + layout.selected(candidates).filter(r => r.type === b.dataset.trackKind).length + ')') })
    } })
    $('tl-track-check').disabled = $('tl-track-uncheck').disabled = !shown.length
  }
  function detailPlayers() {
    const chosen = new Set(detailRoster())
    $('tl-order-players').innerHTML = party().map(id => `<label class="tl-chip"><input type="checkbox" value="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}><span>${esc(person(id))}</span></label>`).join('')
    $('tl-order-players').querySelectorAll('input').forEach(input => { input.onchange = () => {
      layout.detailPlayers = [...$('tl-order-players').querySelectorAll('input:checked')].map(el => el.value)
      saveLayout(); orderPage = 0; actionSequence()
    } })
  }
  function clearDropMarks() { $('tl-group').querySelectorAll('.drop-before,.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after')) }
  function finishDrag() {
    dragKey = ''; clearDropMarks(); $('tl-group').classList.remove('dragging')
    if (groupPending) { groupPending = false; renderGroup() }
  }
  function renderGroup() {
    if (!data) return
    // A live refresh must not detach the handle during an active native drag.
    if (dragKey) { groupPending = true; return }
    const tracks = layout.selected(candidates)
    $('tl-track-count').textContent = `${tracks.length} 条时间线`
    const group = $('tl-group'); group.innerHTML = axis()
    let events = 0
    tracks.forEach((track, index) => {
      const row = track.type === 'action' ? actionLane(track.actor, index) : buffLane(track.lane, index)
      row.dataset.trackId = track.id; row.dataset.trackType = track.type; row.dataset.trackActor = track.actor
      if (track.type === 'action') events += Number(row.dataset.eventCount)
      const label = row.querySelector('.tl-lane-name'), content = document.createElement('div')
      content.className = 'tl-track-label'
      while (label.firstChild) content.append(label.firstChild)
      const handle = document.createElement('button'); handle.className = 'tl-drag-handle'; handle.type = 'button'
      handle.textContent = '⠿'; handle.draggable = true
      handle.title = '拖动调整顺序；也可按 Alt + ↑ / ↓'
      handle.setAttribute('aria-label', '移动 ' + trackLabel(track))
      label.classList.add('tl-track-name'); label.append(handle, content)
      handle.ondragstart = e => {
        dragKey = track.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', track.id)
        group.classList.add('dragging')
      }
      handle.ondragend = finishDrag
      row.ondragover = e => {
        if (!dragKey || dragKey === track.id) return
        e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clearDropMarks()
        const b = row.getBoundingClientRect(); row.classList.add(e.clientY > b.top + b.height / 2 ? 'drop-after' : 'drop-before')
      }
      row.ondrop = e => {
        if (!dragKey) return
        e.preventDefault(); const b = row.getBoundingClientRect()
        if (layout.move(dragKey, track.id, e.clientY > b.top + b.height / 2)) saveLayout('已移动时间线，顺序已保存')
        groupPending = true; finishDrag()
      }
      handle.onkeydown = e => {
        if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault(); const after = e.key === 'ArrowDown', other = tracks[index + (after ? 1 : -1)]
        if (other && layout.move(track.id, other.id, after)) {
          saveLayout('已移动 ' + trackLabel(track)); renderGroup()
          Array.from(group.querySelectorAll('[data-track-id]')).find(r => r.dataset.trackId === track.id)?.querySelector('.tl-drag-handle').focus()
        }
      }
      group.append(row)
    })
    if (!tracks.length) group.insertAdjacentHTML('beforeend', '<p class="tl-empty">时间线组为空。请在上方勾选要加入的内容。</p>')
    $('tl-action-count').textContent = `组内动作 · 当前范围 ${events.toLocaleString()} 条动作／通知`
    $('tl-actions-note').textContent = data.actionTiming?.basis || '动作以服务器实际下发的通知为依据；未记录到的起手时间不会根据命中猜测。'
  }
  function buffLane(lane, index) {
    const container = 'tl-group', wrapper = document.createElement('div')
    const coverage = lane.union.reduce((sum,[a,b]) => sum + Math.max(0,Math.min(to,b)-Math.max(from,a)),0) / Math.max(.001,to-from)
    const intervals = lane.intervals.filter(i => i.end > from && i.start < to)
    const rects = intervals.map((v,i) => {
      const title = `${buff(lane.buffId)} #${lane.buffId}\n${person(lane.actor)} ← ${person(v.source)}\n${clock(v.start)} — ${clock(v.end)} · 层数 ${v.stacks ?? '未知'}\n${v.leftUnknown?'开始前状态不完整；':''}${v.rightUnknown?'结束点未观测到；':''}${v.visibility}`
      return `<g data-interval="${i}" tabindex="0" role="button" aria-label="${esc(title)}"><rect x="${x(v.start)}" y="4" width="${Math.max(.8,x(v.end)-x(v.start))}" height="22" fill="${color(lane.buffId)}"/><rect x="${x(v.start)}" y="4" width="${Math.max(.8,x(v.end)-x(v.start))}" height="22" fill="${v.leftUnknown||v.rightUnknown?'url(#'+container+'-hatch-'+index+')':'transparent'}"/><title>${esc(title)}</title></g>`
    }).join('')
    wrapper.innerHTML = `<div class="tl-lane" data-buff-lane="${index}"><div class="tl-lane-name" title="${esc(buff(lane.buffId)+' #'+lane.buffId)}"><b style="color:${color(lane.buffId)}">${esc(buff(lane.buffId))}</b><small>${esc(person(lane.actor))}</small></div><svg viewBox="0 0 1000 30" preserveAspectRatio="none" aria-label="${esc(buff(lane.buffId))} 覆盖"><defs><pattern id="${container}-hatch-${index}" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 10L10 0" stroke="#101719" stroke-width="3" opacity=".35"/></pattern></defs>${grid(30)}${rects}</svg><span class="tl-percent" title="当前所选时间范围的观测覆盖；重叠实例只计算一次">${(coverage*100).toFixed(1)}%</span></div>`
    const row = wrapper.firstElementChild
    row.querySelectorAll('[data-interval]').forEach(el => {
      const open=()=>{const v=intervals[Number(el.dataset.interval)];detail(`${buff(lane.buffId)} #${lane.buffId}`, [`${person(lane.actor)} ← ${person(v.source)}`,`${clock(v.start)} — ${clock(v.end)} · 层数 ${v.stacks ?? '未知'}`,v.leftUnknown||v.rightUnknown?'这是起止不完整的观测区间，条纹不是已确认的完整覆盖。':'添加与移除通知之间的观测区间。'])}
      el.onclick=open;el.onkeydown=e=>{if(e.key==='Enter')open()}
    })
    return row
  }
  const seconds = n => Number.isFinite(n) ? n.toFixed(3) + ' 秒' : '未确认'
  const exactTime = t => `${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toFixed(3).padStart(6,'0')}`
  const reason = r => ({'queue-removed':'同一技能同步条目已移除','queue-replaced':'下一动作覆盖，真实结束未确认','next-action':'下一动作开始，真实结束未确认','range-end':'记录结束时仍未确认结束','space-data-reset':'场景切换，观测中断','entity-snapshot':'重新收到实体快照','server-skill-end':'技能结束同步','observed-aoi-leave':'离开可见范围','observed-aoi-remove':'实体从可见范围移除','guid-rebound':'实体标识重新绑定','queue-container-reset':'同步动作状态重置'}[r] || r || '边界未知')
  function spanDetail(v) {
    detail(`${person(v.actor)} · 第 ${v.order} 个动作 · ${skill(v.skillId)}`, [
      `${exactTime(v.start)} — ${exactTime(v.end)} · 同步动作时长 ${seconds(v.duration)}`,
      v.duration==null?'条纹区间仅表示观测范围，不能当作实际持续时间。':`与上一动作间隔 ${seconds(v.gapBefore)}`,
      `结束依据：${reason(v.endReason)}`, `目标：${person(v.target)}`,
      '这是同步队列中观测到的动作占用，不等同客户端动画帧、前摇或后摇；延迟命中可能在动作结束后到达。'])
  }
  function actionSequence() {
    if (!data) return
    const timing=data.actionTiming || {spans:[],gaps:[]}, roster=detailRoster()
    const query=$('tl-order-skill-search').value.trim().toLowerCase(), matches=id=>`${skill(id)} ${id}`.toLowerCase().includes(query)
    const gapMode=$('tl-order-kind').value==='gaps', minimum=Math.max(0,Number($('tl-gap-min').value)||0)
    const allSpans=timing.spans.filter(v=>roster.includes(v.actor)&&v.end>=from&&v.start<=to)
    const allGaps=timing.gaps.filter(v=>roster.includes(v.actor)&&v.start>=from&&v.end<=to)
    $('tl-action-summary').innerHTML=roster.map(id=>{
      const spans=allSpans.filter(v=>v.actor===id), gaps=allGaps.filter(v=>v.actor===id&&v.duration>=minimum)
      return `<div><b>${esc(person(id))}</b><span>${spans.filter(v=>v.duration!=null).length} / ${spans.length} 动作起止完整</span><span>${gaps.length} 段待复查间隔 · ${seconds(gaps.reduce((n,g)=>n+g.duration,0))}</span></div>`
    }).join('')
    const rows=gapMode?allGaps.filter(v=>v.duration>=minimum&&(matches(v.previousSkill)||matches(v.nextSkill))).sort((a,b)=>b.duration-a.duration):allSpans.filter(v=>matches(v.skillId))
    const size=60, pages=Math.max(1,Math.ceil(rows.length/size));orderPage=Math.max(0,Math.min(orderPage,pages-1))
    const shown=rows.slice(orderPage*size,(orderPage+1)*size)
    $('tl-order-head').innerHTML=gapMode?'<tr><th>角色</th><th>区间</th><th>间隔</th><th>前后动作</th><th></th></tr>':'<tr><th>角色／顺序</th><th>动作</th><th>开始 → 结束</th><th>动作时长</th><th>前次间隔</th><th></th></tr>'
    $('tl-order-rows').innerHTML=shown.map((v,i)=>gapMode?
      `<tr><td>${esc(person(v.actor))}</td><td>${exactTime(v.start)} → ${exactTime(v.end)}</td><td>${seconds(v.duration)}</td><td>${esc(skill(v.previousSkill))} → ${esc(skill(v.nextSkill))}</td><td><button data-near="${i}">查看附近</button></td></tr>`:
      `<tr><td>${esc(person(v.actor))}<small>第 ${v.order} 个动作</small></td><td><button data-span-detail="${i}">${esc(skill(v.skillId))}</button><small>#${esc(v.skillId)}</small></td><td>${exactTime(v.start)} → ${v.endKnown?exactTime(v.end):'未确认'}${!v.startKnown?'<small>开始边界不完整</small>':''}</td><td>${seconds(v.duration)}</td><td>${seconds(v.gapBefore)}</td><td><button data-near="${i}">查看附近</button></td></tr>`).join('') || `<tr><td colspan="6" class="muted">${!roster.length?'请勾选要查看动作明细的角色。':gapMode?'没有满足条件的已观测间隔；不表示全程没有空档。':'没有匹配的动作区间。'}</td></tr>`
    $('tl-order-count').textContent=`${rows.length} 条 · 第 ${orderPage+1} / ${pages} 页`
    $('tl-order-prev').disabled=orderPage===0;$('tl-order-next').disabled=orderPage>=pages-1
    $('tl-order-rows').querySelectorAll('[data-span-detail]').forEach(b=>{b.onclick=()=>spanDetail(shown[Number(b.dataset.spanDetail)])})
    $('tl-order-rows').querySelectorAll('[data-near]').forEach(b=>{b.onclick=()=>{const v=shown[Number(b.dataset.near)];actor=v.actor;from=Math.max(0,v.start-2);to=Math.min(data.duration,v.end+2);orderPage=0;layout.set(laneId('action',v.actor),true);saveLayout();render();[...$('tl-group').querySelectorAll('[data-track-type=action]')].find(r=>r.dataset.trackActor===v.actor)?.scrollIntoView({block:'center'})}})
  }
  function actionLane(id, index) {
    const mode=$('tl-action-kind').value, query=$('tl-skill-search').value.trim().toLowerCase()
    const roster=[id], wrapper=document.createElement('div')
    const events=data.actions.filter(e=>!['visibility','boundary'].includes(e.kind)&&roster.includes(e.actor)&&e.t>=from&&e.t<=to&&(mode==='all'||(mode==='hit'?e.kind==='hit':e.kind!=='hit'))&&`${skill(e.skillId)} ${e.skillId}`.toLowerCase().includes(query))
    const labels={cast:'技能开始',end:'同步动作结束',boundary:'结束边界未确认',visibility:'观测范围改变',segment:'技能分段',snapshot:'入场时技能快照',hit:'命中／治疗通知'}
    const describe=e=>`${clock(e.t)} · ${labels[e.kind]||e.kind} · ${skill(e.skillId)} #${e.skillId ?? '未记录'}\n${person(e.actor)} → ${person(e.target)}${e.amount!=null?' · 数值 '+fmt(e.amount):''}${e.segment!=null?' · 第 '+e.segment+' 段':''}`
    const rows=events.filter(e=>e.actor===id)
    const spans=(data.actionTiming?.spans||[]).filter(v=>v.actor===id&&v.end>=from&&v.start<=to&&`${skill(v.skillId)} ${v.skillId}`.toLowerCase().includes(query))
    const gaps=(data.actionTiming?.gaps||[]).filter(v=>v.actor===id&&v.end>from&&v.start<to)
    const bars=mode==='hit'?'':spans.map((v,i)=>{
      const width=Math.max(1,x(v.end)-x(v.start)), uncertain=v.duration==null
      const title=esc(`${skill(v.skillId)} · ${exactTime(v.start)} — ${v.endKnown?exactTime(v.end):'未确认'} · ${seconds(v.duration)}`)
      return `<g data-span="${i}" role="button" tabindex="0" aria-label="${title}"><rect x="${x(v.start)}" y="5" width="${width}" height="24" rx="2" fill="${color(v.skillId)}" opacity="${uncertain?'.3':'.85'}"/>${uncertain?`<rect x="${x(v.start)}" y="5" width="${width}" height="24" fill="url(#action-hatch-${index})"/>`:''}${width>=100?`<clipPath id="action-text-${index}-${i}"><rect x="${x(v.start)+3}" y="5" width="${Math.max(0,width-6)}" height="24"/></clipPath><text x="${x(v.start)+5}" y="22" font-size="13" fill="${uncertain?'#d5dfdb':'#122020'}" pointer-events="none" clip-path="url(#action-text-${index}-${i})">${esc(skill(v.skillId))}</text>`:''}<title>${title}</title></g>`
    }).join('')
    const pauses=mode==='hit'?'':gaps.map(v=>`<rect x="${x(v.start)}" y="7" width="${Math.max(.5,x(v.end)-x(v.start))}" height="20" fill="#8c999a12" stroke="#849698" stroke-dasharray="2 3"><title>待复查间隔 ${seconds(v.duration)}；不能直接判定为散步</title></rect>`).join('')
    const marks=rows.map((e,i)=>{
      if (['visibility','boundary'].includes(e.kind)) return ''
      const cx=x(e.t), cy=42+(i%3)*11, title=esc(describe(e))
      const shape=e.kind==='hit'?`<circle cx="${cx}" cy="${cy}" r="3.2" fill="${color(e.skillId)}"/>`:e.kind==='segment'?`<path d="M${cx-3} ${cy-4}l7 4 -7 4Z" fill="none" stroke="${color(e.skillId)}"/>`:e.kind==='snapshot'?`<rect x="${cx-3}" y="${cy-3}" width="6" height="6" fill="none" stroke="#94a8a6"/>`:`<path d="M${cx} ${cy-4}l4 4 -4 4 -4 -4Z" fill="${e.kind==='end'?'none':color(e.skillId)}" stroke="${color(e.skillId)}"/>`
      return `<g data-action="${i}" role="button" tabindex="0" aria-label="${title}">${shape}<title>${title}</title></g>`
    }).join('')
    wrapper.innerHTML = `<div class="tl-lane tl-track-action" data-action-lane="${index}"><div class="tl-lane-name"><b>${esc(person(id))}</b><small>${rows.length} 条</small></div><svg viewBox="0 0 1000 78" preserveAspectRatio="none" aria-label="${esc(person(id))} 动作时间线"><defs><pattern id="action-hatch-${index}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8L8 0" stroke="#bdc7c5" stroke-width="2" opacity=".5"/></pattern></defs>${grid(78)}${pauses}${bars}${marks}</svg><span class="tl-percent">${rows.length?'':'未观测'}</span></div>`
    const lane = wrapper.firstElementChild
    lane.dataset.eventCount = rows.length
    const open=at=>detail(`${person(id)} · ${clock(at)} 附近的全部动作`,rows.filter(e=>Math.abs(e.t-at)<.3).map(describe))
    lane.querySelectorAll('[data-span]').forEach(el=>{el.onkeydown=e=>{if(e.key==='Enter')spanDetail(spans[Number(el.dataset.span)])}})
    lane.querySelector('svg').onclick=e=>{const bar=e.target.closest('[data-span]');if(bar){spanDetail(spans[Number(bar.dataset.span)]);return}const el=e.target.closest('[data-action]');if(el)open(rows[Number(el.dataset.action)].t);else{const b=e.currentTarget.getBoundingClientRect();open(from+(e.clientX-b.left)/b.width*(to-from))}}
    lane.querySelectorAll('[data-action]').forEach(el=>{el.onkeydown=e=>{if(e.key==='Enter')open(rows[Number(el.dataset.action)].t)}})
    return lane
  }
  return { show }
})()
