// 触屏的化身操作：左下摇杆，右下主按钮写出现在能做的事（等于按 E），旁边是背包（B）和换目标（Tab）。
// 摇杆给的是连续方向，推得轻走得慢；松手停下。只在触屏显示（见 style.css 的 [data-input='touch']）。
import { button, el } from '../dom'
import { gameIcon } from '../game/icons'
import type { AvatarPrompt } from '../gameMap'

interface TouchDeps {
  stick(direction: [number, number] | null): void
  act(): void
  bag(): void
  cycle(): void
}

/** 摇杆半径（CSS 像素）：手指离中心这么远算推到底 */
const RADIUS = 40
/** 推得太轻不算，免得手指一碰就挪 */
const DEAD_ZONE = 0.18

/** 主按钮上的两个字；完整说法写在按钮上方 */
function verb(prompt: AvatarPrompt) {
  if (prompt.kind === 'person') return '交谈'
  if (prompt.kind === 'portal') return '进出'
  return /^(拾取|取回)/.test(prompt.label) ? '拾取' : '使用'
}

export function createAvatarTouch(root: HTMLElement, d: TouchDeps, signal: AbortSignal) {
  const box = el('div', '', 'avatar-touch')
  box.hidden = true
  const pad = el('div', '', 'avatar-stick')
  pad.setAttribute('aria-label', '移动摇杆：按住拖动')
  const knob = el('div', '', 'avatar-knob')
  pad.append(knob)
  const label = el('div', '', 'avatar-act-label')
  const main = button('', d.act, 'avatar-act-main')
  const mainText = el('span', '互动')
  main.append(gameIcon('hand', true), mainText)
  const bag = button('', d.bag, 'avatar-act-small avatar-act-bag')
  bag.append(gameIcon('bag', true), el('span', '背包'))
  const cycle = button('', d.cycle, 'avatar-act-small avatar-act-cycle')
  cycle.append(gameIcon('cycle', true), el('span', '换目标'))
  box.append(pad, label, main, bag, cycle)
  root.append(box)

  let pointer: number | null = null
  const move = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect()
    let dx = e.clientX - (r.left + r.width / 2),
      dy = e.clientY - (r.top + r.height / 2)
    const distance = Math.hypot(dx, dy)
    if (distance > RADIUS) {
      dx = (dx / distance) * RADIUS
      dy = (dy / distance) * RADIUS
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`
    const push = Math.hypot(dx, dy) / RADIUS
    d.stick(push < DEAD_ZONE ? null : [dx / RADIUS, dy / RADIUS])
  }
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return
    pointer = null
    knob.style.transform = ''
    d.stick(null)
  }
  pad.addEventListener(
    'pointerdown',
    (e) => {
      pointer = e.pointerId
      try {
        pad.setPointerCapture(e.pointerId)
      } catch {
        // 指针已经抬起时捕获会失败
      }
      move(e)
    },
    { signal }
  )
  pad.addEventListener('pointermove', (e) => e.pointerId === pointer && move(e), { signal })
  pad.addEventListener('pointerup', end, { signal })
  pad.addEventListener('pointercancel', end, { signal })

  return {
    /** 控制中才显示；prompts 是地图上的提示标签，当前对象带 focused，能立刻做的带 key */
    render(controlling: boolean, prompts: AvatarPrompt[]) {
      box.hidden = !controlling
      if (!controlling) return
      const current = prompts.find((p) => p.focused)
      main.classList.toggle('ready', !!current?.key)
      mainText.textContent = current ? verb(current) : '互动'
      label.textContent = current ? current.label : '附近没有可以互动的'
      cycle.hidden = prompts.length < 2
    },
  }
}
