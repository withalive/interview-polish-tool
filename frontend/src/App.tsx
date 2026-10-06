import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import Login from './auth/Login';
import AppShell from './components/AppShell';
import AudioExtractPage from './pages/AudioExtractPage';
import TextExtractPage from './pages/TextExtractPage';
import TopicSplitPage from './pages/TopicSplitPage';
import { queryClient } from './lib/queryClient';

// Pages는 SPA 경로를 index.html로 돌려주지 않으므로 해시 라우팅을 쓴다.
const Router = import.meta.env.MODE === 'github-pages' ? HashRouter : BrowserRouter;

function AuthGate() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        로딩 중…
      </div>
    );
  }

  // 미인증 상태에서는 라우터 자체를 렌더하지 않는다.
  // 로그아웃 후 뒤로가기로 URL이 바뀌어도 앱 화면에 닿을 수 없다.
  if (status === 'unauthenticated') {
    return <Login />;
  }

  return (
    <Router>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<AudioExtractPage />} />
          <Route path="/text" element={<TextExtractPage />} />
          <Route path="/topics" element={<TopicSplitPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </QueryClientProvider>
  );
}
