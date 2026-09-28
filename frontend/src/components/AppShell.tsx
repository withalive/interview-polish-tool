import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? 'rounded-md bg-sky-100 px-3 py-1.5 text-sm font-medium text-sky-700'
    : 'rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100';

export default function AppShell() {
  const { email, groups, logout } = useAuth();
  const isAdmin = groups.includes('admin');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold">
              인터뷰 처리 도구
            </Link>
            <nav className="flex items-center gap-1">
              <NavLink to="/" className={navLinkClass} end>
                음성 추출
              </NavLink>
              <NavLink to="/text" className={navLinkClass}>
                텍스트 추출
              </NavLink>
              <NavLink to="/topics" className={navLinkClass}>
                주제 나누기
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="text-right">
              <div className="text-slate-700">{email}</div>
              {isAdmin && <div className="text-xs text-sky-600">admin</div>}
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
