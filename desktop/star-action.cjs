'use strict'
// Shared by the global shortcut and overlay button. Never changes focus.
function createStarAction({ isVisible, source, save, changed, feedback }) {
  let busy = false
  return async () => {
    if (busy || !isVisible()) return
    busy = true
    let result
    try {
      if (source() !== 'live') throw Error('请切换到实时悬浮窗，或在本地日志列表点击 ☆ 收藏')
      result = await save()
      changed(result)
    } catch (error) { result = { ok: false, error: error.message } }
    finally { busy = false }
    feedback(result)
    return result
  }
}
module.exports = { createStarAction }
