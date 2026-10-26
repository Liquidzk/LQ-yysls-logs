'use strict';
let castRequest=0,viewSaveTimer;

function activateTab(tab){
  if(!['overview','skills','buffs','damage','events'].includes(tab))tab='overview';
  S.tab=tab;
  document.querySelectorAll('[data-tab]').forEach(b=>{const active=b.dataset.tab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
  document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==tab+'-panel');
  if(S.report&&tab==='overview')drawTimeline();
  scheduleViewSave();
}

function saveReviewView(){
  if(!S.report)return;
  const view={key:S.report.key,actor:S.actor,tab:S.tab,time:S.time,from:S.from,to:S.to,
    filters:Object.fromEntries(['cast-search','cast-kind','buff-search','event-search','event-type','damage-mode'].map(id=>[id,$(id).value])),
    externalOnly:$('external-only').checked,showNpc:$('show-npc').checked};
  try{localStorage.setItem('yanyun-review-view',JSON.stringify(view));}catch{}
}
function scheduleViewSave(){clearTimeout(viewSaveTimer);viewSaveTimer=setTimeout(saveReviewView,250);}
function restoreReviewView(){
  let view;try{view=JSON.parse(localStorage.getItem('yanyun-review-view'));}catch{}
  if(!view||view.key!==S.report.key){activateTab(S.tab);return;}
  if([...$('actor-select').options].some(o=>o.value===view.actor)){S.actor=view.actor;$('actor-select').value=S.actor;}
  const duration=S.report.duration;
  if(Number.isFinite(view.from)&&Number.isFinite(view.to)&&view.from>=0&&view.from<view.to&&view.from<duration){S.from=view.from;S.to=Math.min(duration,view.to);}
  S.time=Math.max(S.from,Math.min(S.to,Number.isFinite(view.time)?view.time:0));
  for(const id of ['cast-search','cast-kind','buff-search','event-search','event-type','damage-mode']){
    const value=view.filters?.[id],el=$(id);
    if(typeof value==='string'&&(el.tagName!=='SELECT'||[...el.options].some(o=>o.value===value)))el.value=value;
  }
  $('external-only').checked=view.externalOnly===true;$('show-npc').checked=view.showNpc!==false;
  $('range-from').value=S.from;$('range-to').value=S.to.toFixed(3);$('cursor').min=S.from;$('cursor').max=S.to;
  activateTab(view.tab);
}

function renderCastReview(){
  const q=$('cast-search').value.trim().toLowerCase(),kind=$('cast-kind').value;
  const base=S.report.casts.filter(c=>c.start>=S.from&&c.start<=S.to&&(S.actor==='all'||c.actor===S.actor)
    &&(!q||`${skillName(c.skill)} ${c.skill??''} ${actorName(c.actor)}`.toLowerCase().includes(q)));
  const casts=base.filter(c=>c.kind==='cast');
  $('cast-summary').innerHTML=[['确认开始',casts.length],['同技能中断',casts.filter(c=>c.interrupted).length],['起点已见外部 Buff',casts.filter(c=>c.external_buffs_at_start>0).length],['仅同步通知',base.length-casts.length]].map(([label,count])=>`<div><strong>${fmt(count)}</strong><span>${label}</span></div>`).join('');
  const rows=base.filter(c=>kind==='all'||(kind==='interrupted'?c.kind==='cast'&&c.interrupted:c.kind===kind));
  const size=18,pages=Math.max(1,Math.ceil(rows.length/size));S.castPage=Math.min(S.castPage||0,pages-1);
  $('cast-table').innerHTML=rows.slice(S.castPage*size,(S.castPage+1)*size).map(c=>`<tr class="interactive" data-cast-id="${escapeHTML(c.id)}" tabindex="0" role="button" aria-label="查看 ${escapeHTML(skillName(c.skill))} ${clock(c.start)} 的动作详情"><td>${clock(c.start)}<small>${escapeHTML(actorName(c.actor))}</small></td><td>${escapeHTML(skillName(c.skill))}<small>#${escapeHTML(c.skill??'—')}</small></td><td>${c.kind==='sync'?'同步通知':c.end_known?(c.end-c.start).toFixed(3)+' 秒':'结束边界未知'}<small>${c.interrupted?'同技能中断':c.kind==='sync'?'未证实施放':c.end_known?'已见开始与离开':'后续状态不全'}</small></td><td>${c.buffs_at_start??0} 组<small>${c.external_buffs_at_start??0} 组来自其他来源</small></td></tr>`).join('')||'<tr><td colspan="4" class="empty-row">没有匹配的动作记录。可切换“全部动作记录”查看同步通知。</td></tr>';
  bindCastDetails($('cast-table'));
  $('cast-page-label').textContent=`${rows.length} 条动作 · ${S.castPage+1} / ${pages}`;
  $('cast-prev').disabled=S.castPage===0;$('cast-next').disabled=S.castPage>=pages-1;
}
function bindCastDetails(root){
  root.querySelectorAll('[data-cast-id]').forEach(el=>{
    el.onclick=()=>showCast(el.dataset.castId);
    if(el.tagName!=='BUTTON')el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}};
  });
}

async function showCast(id){
  const report=S.report,cast=report?.casts.find(c=>c.id===id);if(!cast)return;
  stopPlayback();setTime(cast.start);const request=++castRequest;
  modal(`${skillName(cast.skill)} · ${clock(cast.start)}`,'<p>正在整理本次动作的状态和事件…</p>');
  try{
    const detail=await api('/api/cast-review',{ids:[...S.ids],offsets:{...S.offsets},revision:report.revision,cast_id:id});
    if(request!==castRequest||S.report!==report||!$('dialog').open)return;
    renderCastDetail(detail);
  }catch(e){
    if(request!==castRequest||S.report!==report||!$('dialog').open)return;
    modal('动作详情暂不可用',`<p>${escapeHTML(e.message)}</p><button id="reload-cast-report">重新载入当前记录</button>`);
    $('reload-cast-report').onclick=async()=>{try{await openReport(S.ids,S.offsets);$('dialog').close();}catch(err){toast(err.message);}};
  }
}

function renderCastDetail(d){
  const c=d.cast,lookup=new Map(S.report.events.map(e=>[e.id,e]));
  const phases=[...new Set([...c.phase_events,...c.interrupt_events])].sort((a,b)=>a-b).map(id=>lookup.get(id)).filter(Boolean);
  const peers=d.peers.map(id=>S.report.casts.find(cast=>cast.id===id)).filter(Boolean);
  const amount=m=>m.amount==null?'未取得':fmt(m.amount,1);
  const eventRows=ids=>ids.map(id=>lookup.get(id)).filter(Boolean).map(e=>`<tr class="interactive" data-event-id="${e.id}"><td>${clock(e.t)}</td><td>${escapeHTML(eventName(e))}</td><td>${escapeHTML(relation(e))}</td><td>${escapeHTML(eventValue(e))}</td></tr>`).join('');
  const eventTable=ids=>`<div class="table-wrap detail-event-table"><table><thead><tr><th>时间</th><th>事件</th><th>来源 → 目标</th><th>记录内容</th></tr></thead><tbody>${eventRows(ids)}</tbody></table></div>`;
  modal(`${skillName(c.skill)} · ${clock(c.start)}`,`${nameEvidenceHTML('skills',c.skill)}
    <p>${escapeHTML(actorName(c.actor))} · ${c.kind==='sync'?'仅同步通知，未证实施放':c.end_known?`已见状态区间 ${clock(c.start)} — ${clock(c.end)}`:`已见开始，区间截至 ${clock(c.end)}，结束尚未确认`}${c.interrupted?' · 有同技能中断记录':''}</p>
    <div class="dialog-actions cast-navigation"><button id="previous-cast" ${d.previous?'':'disabled'}>上一个动作</button><button id="cast-jump">回到此刻快照</button><button id="next-cast" ${d.next?'':'disabled'}>下一个动作</button></div>
    <div class="cast-detail-metrics"><div><span>区间内同技能伤害</span><strong>${amount(d.damage)}</strong><small>${d.damage.records} 条对外伤害记录${d.damage.per_second==null?'':` · 区间每秒 ${fmt(d.damage.per_second,1)}`}</small></div><div><span>区间内同技能治疗</span><strong>${amount(d.heal)}</strong><small>${d.heal.records} 条治疗记录</small></div></div>
    <p class="subtle-help">仅按施加者、技能编号和状态区间筛选。延迟命中可能来自此前施放，因此这些数值不代表本次施放的确定伤害归属或完整 DPS。${d.multi_view_uncertainty?'当前含多个视角，同时间戳的跨视角顺序与重复回报仍有不确定性。':''}</p>
    <h3>技能阶段</h3><p>中断事件也可能由正常技能衔接触发，不直接判定为施放失败。</p><div class="phase-list">${phases.map(e=>`<button data-phase-event="${e.id}"><time>+${(e.t-c.start).toFixed(3)}s</time><span>${escapeHTML(eventName(e))}</span></button>`).join('')||'<p>未取得技能状态变化。</p>'}</div>
    <h3>施放者的 Buff 与来源</h3><p>起点层数按事件先后读取；持续时间按已见事件延续。初始状态未知，未列出的 Buff 不代表不存在。</p>
    <div class="table-wrap detail-buffs"><table><thead><tr><th>Buff / 施加者</th><th>起点状态</th><th>区间内覆盖</th></tr></thead><tbody>${d.buffs.map((b,i)=>`<tr class="interactive" data-review-buff="${i}"><td>${escapeHTML(buffName(b.buff))}<small>${escapeHTML(actorName(b.source))}${b.external?' · 外部来源':''}</small></td><td>${b.active_at_start?'已见存在'+(b.stacks_at_start==null?' · 层数未知':' · '+escapeHTML(b.stacks_at_start)+' 层'):'区间内新增 / 首次观测'}</td><td>${b.coverage==null?'—':(b.coverage*100).toFixed(1)+'%'}<small>${b.coverage==null?'只有时间点':b.seconds.toFixed(3)+' 秒'}${b.partial?' · 暂估':''}</small></td></tr>`).join('')||'<tr><td colspan="3" class="empty-row">未取得该时段的 Buff 状态。</td></tr>'}</tbody></table></div>
    <h3>起点时其他玩家的动作</h3><div class="peer-casts">${peers.map(p=>`<button data-cast-id="${p.id}">${escapeHTML(actorName(p.actor))}<small>${escapeHTML(skillName(p.skill))} · ${p.end_known?'状态区间内':'按缺失结束边界暂估'}</small></button>`).join('')||'<p>没有可重建的其他玩家进行中动作；日志可能未记录。</p>'}</div>
    <details class="review-details"><summary>区间内同技能命中记录 · ${d.matching_events.length} 条</summary>${d.matching_events.length?eventTable(d.matching_events):'<p>未取得匹配的伤害或治疗记录。</p>'}</details>
    <details class="review-details"><summary>前后 2 秒及区间内相关事件 · ${d.nearby_total} 条</summary>${d.nearby_total>200?'<p>显示前 200 条，完整内容可在事件记录中按区间查看。</p>':''}${eventTable(d.nearby_events)}</details>`);
  $('previous-cast').onclick=()=>showCast(d.previous);$('next-cast').onclick=()=>showCast(d.next);
  $('cast-jump').onclick=()=>{setTime(c.start);$('dialog').close();};
  $('dialog-body').querySelectorAll('[data-phase-event]').forEach(b=>b.onclick=()=>{setTime(lookup.get(Number(b.dataset.phaseEvent)).t);$('dialog').close();});
  $('dialog-body').querySelectorAll('[data-review-buff]').forEach(row=>row.onclick=()=>showBuff(d.buffs[Number(row.dataset.reviewBuff)]));
  bindCastDetails($('dialog-body'));bindEventDetails($('dialog-body'));
}

function setupReview(){
  $('cast-search').oninput=$('cast-kind').onchange=()=>{S.castPage=0;if(S.report)renderCastReview();scheduleViewSave();};
  $('cast-prev').onclick=()=>{S.castPage--;renderCastReview();};$('cast-next').onclick=()=>{S.castPage++;renderCastReview();};
  $('buff-search').oninput=()=>{S.buffPage=0;if(S.report)renderBuffs();scheduleViewSave();};
  document.querySelectorAll('input,select').forEach(el=>{el.addEventListener('change',scheduleViewSave);el.addEventListener('input',scheduleViewSave);});
  $('dialog').addEventListener('close',()=>{castRequest++;});
  window.addEventListener('pagehide',saveReviewView);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveReviewView();});
}
