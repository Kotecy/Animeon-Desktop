type OrderedTab = { id: string; pinned?: boolean }

export function getTabOrder(tabs: readonly OrderedTab[], saved: unknown): string[] {
  const remaining = new Set(tabs.map(tab => tab.id))
  const ordered = Array.isArray(saved) ? saved.filter(id => remaining.delete(id)) : []
  ordered.push(...remaining)
  const pinned = new Set(tabs.filter(tab => tab.pinned).map(tab => tab.id))
  return [...ordered.filter(id => pinned.has(id)), ...ordered.filter(id => !pinned.has(id))]
}

export function sameTabOrder(expected: readonly string[], actual: unknown): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && expected.every((id, index) => actual[index] === id)
}

export function moveTab(tabs: readonly OrderedTab[], order: readonly string[], from: number, to: number): string[] | null {
  if (from < 0 || to < 0 || from === to || from >= order.length || to >= order.length) return null
  const pinned = new Set(tabs.filter(tab => tab.pinned).map(tab => tab.id))
  const draggedId = order[from]
  if (pinned.has(draggedId) !== pinned.has(order[to])) return null
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, draggedId)
  return next
}
