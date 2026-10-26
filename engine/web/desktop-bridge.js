/* Desktop-specific integration; the existing report remains usable for local QA. */
let kagerouTimer
window.scheduleKagerouView = function () {
  clearTimeout(kagerouTimer)
  kagerouTimer = setTimeout(() => publishKagerou().catch(() => {}), 150)
}
async function publishKagerou() {
  if (!S.report) return
  return api('/api/overlay-view', { ids: S.ids, offsets: S.offsets, from: S.from, to: S.to })
}
document.getElementById('kagerou-button').onclick = async () => {
  try {
    await publishKagerou()
    if (window.yanyunDesktop) await window.yanyunDesktop.showKagerou()
    else window.open('/kagerou/yanyun/', 'yanyun-kagerou')
  } catch (error) { toast(error.message) }
}
window.yanyunDesktop?.onSelectActor(id => { if (S.report) selectActor(id) })
window.scheduleKagerouView()
