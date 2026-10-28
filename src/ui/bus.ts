// Tiny event bus for one-off commands to the 3D viewer (e.g. "turn to this face").
type Events = { lookAt: string; fit: undefined };

const handlers = new Map<keyof Events, Set<(payload: never) => void>>();

export const viewerBus = {
  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void) {
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => {
      set.delete(fn as (payload: never) => void);
    };
  },
  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    handlers.get(event)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload));
  },
};
