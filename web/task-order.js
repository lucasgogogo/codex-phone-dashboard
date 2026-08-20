export function sortTasksForDisplay(items, promotionTime = () => 0) {
  return items
    .map((item, index) => ({
      item,
      index,
      runningPriority: item.state === "running" ? 0 : 1,
      promotedAt: Number(promotionTime(item)) || 0
    }))
    .sort((left, right) =>
      (left.runningPriority - right.runningPriority) ||
      (right.promotedAt - left.promotedAt) ||
      (left.index - right.index)
    )
    .map(({ item }) => item);
}
