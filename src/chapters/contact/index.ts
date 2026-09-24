import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el } from '../../core/dom'

// PLACEHOLDER — replaced by the contact chapter build.
export default function create(): Chapter {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.28, 220, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 }),
  )
  group.add(mesh)
  return {
    id: 'contact',
    group,
    init(ctx) {
      if (0) ctx.stage.classList.add('is-dark')
      el('p', 'hud-eyebrow', 'Say Hello', ctx.stage).style.cssText = 'position:absolute;left:var(--gutter);top:var(--safe-top)'
      const h = el('h2', 'hud-h2', undefined, ctx.stage)
      h.innerHTML = 'Say <em>hello.</em>'
      h.style.cssText = 'position:absolute;left:var(--gutter);top:calc(var(--safe-top) + 34px)'
    },
    update(local, frame, ctx) {
      ctx.studio.params.tone = 0
      mesh.rotation.set(local * 3, frame.time * 0.3, 0)
    },
    camera(_local, _frame, out) {
      out.position.set(0, 0, 6)
      out.target.set(0, 0, 0)
      out.fov = 40
      out.parallax = 0.4
    },
  }
}
