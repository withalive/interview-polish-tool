import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthProvider';
import { API_CONFIGURATION_NOTICE, needsApiConfiguration } from '../lib/api';

export default function Login() {
  const { login, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">로그인</h1>
        <p className="mt-1 text-sm text-slate-500">
          인터뷰 처리 도구 (내부 도구)
        </p>

        {needsApiConfiguration && (
          <p role="status" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            {API_CONFIGURATION_NOTICE}
          </p>
        )}

        <form onSubmit={handleSignIn} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              이메일
            </label>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              비밀번호
            </label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          {notice && !error && (
            <p className="text-xs text-slate-500">{notice}</p>
          )}
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={busy || needsApiConfiguration}
            className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? '로그인 중…' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}
