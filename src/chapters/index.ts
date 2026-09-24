import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights; `landing` is where nav jumps land (local progress). Each chapter
 * lives in src/chapters/<id>/ and default-exports a factory returning a
 * Chapter (see src/core/types.ts).
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Listen', length: 2.6, landing: 0, load: () => import('./hero/index') },
  { id: 'work', label: 'The Crate', length: 3.8, landing: 0.12, load: () => import('./work/index') },
  // the album spine: liner notes straight after the records
  { id: 'voices', label: 'Liner Notes', length: 3.2, landing: 0.05, load: () => import('./voices/index') },
  { id: 'services', label: 'Cymatics', length: 3.6, landing: 0.08, load: () => import('./services/index') },
  { id: 'shield', label: 'Noise Floor', length: 1.6, landing: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'The Desk', length: 1.8, load: () => import('./process/index') },
  { id: 'contact', label: 'Say Hello', length: 1.5, landing: 0.3, load: () => import('./contact/index') },
]
