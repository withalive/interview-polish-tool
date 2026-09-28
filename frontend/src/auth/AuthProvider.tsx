import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { onUnauthorized } from '../lib/authEvents';
import { clearJobSessionId } from '../lib/jobSession';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  email: string | null;
  groups: string[];
  /** 세션이 끊겨 로그인 화면으로 돌아온 경우에만 채워진다. */
  notice: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SIGNED_OUT: AuthState = {
  status: 'unauthenticated',
  email: null,
  groups: [],
  notice: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    email: null,
    groups: [],
    notice: null,
  });

  /**
   * 세션 확인 요청의 세대 번호.
   *
   * StrictMode는 마운트 시 확인 요청을 두 번 보내고, 로그인·로그아웃도
   * 상태를 바꾼다. 늦게 도착한 오래된 응답이 최신 상태를 덮어쓰면
   * 로그인 직후 다시 로그인 화면으로 튕기므로, 세대가 다르면 버린다.
   */
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    const generation = (epoch.current += 1);
    const isStale = () => epoch.current !== generation;
    try {
      const user = await api.me();
      if (isStale()) return;
      setState({
        status: 'authenticated',
        email: user.email,
        groups: user.groups,
        notice: null,
      });
    } catch {
      if (isStale()) return;
      setState(SIGNED_OUT);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 뒤로가기로 bfcache에서 복원되면 DOM이 로그인 상태 그대로 되살아난다.
  // 복원 시점에 세션을 다시 확인해 끊긴 경우 로그인 화면으로 돌린다.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [refresh]);

  // 작업 API가 401을 받으면 세션이 끊긴 것이다 — 안내와 함께 로그인 화면으로.
  useEffect(
    () =>
      onUnauthorized(() => {
        epoch.current += 1;
        clearJobSessionId();
        setState((prev) =>
          prev.status === 'authenticated'
            ? {
                ...SIGNED_OUT,
                notice: '세션이 만료되었습니다. 다시 로그인해주세요.',
              }
            : prev,
        );
      }),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const user = await api.login(email, password);
    // 진행 중인 세션 확인 응답이 이 결과를 덮어쓰지 않게 한다.
    epoch.current += 1;
    setState({
      status: 'authenticated',
      email: user.email,
      groups: user.groups,
      notice: null,
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      epoch.current += 1;
      // 다음 사용자가 이전 사용자의 업로드 목록을 이어받지 않게 한다.
      clearJobSessionId();
      setState(SIGNED_OUT);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth는 AuthProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
