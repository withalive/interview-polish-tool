// API가 401을 받았을 때 AuthProvider에 알리는 얇은 채널.
// (api.ts가 React 컨텍스트를 모르는 채로 세션 만료를 전달하기 위함)

type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitUnauthorized(): void {
  for (const listener of listeners) listener();
}
