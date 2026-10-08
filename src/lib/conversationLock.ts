// One queue per patient shared by the agent, staff takeover and staff replies.
const queues = new Map<string, Promise<unknown>>();
export async function withConversation<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(id, current);
  try { return await current; } finally { if (queues.get(id) === current) queues.delete(id); }
}
