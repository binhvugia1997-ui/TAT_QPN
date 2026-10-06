import { NavLink, Outlet } from 'react-router-dom';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import type { ServerStatus } from '../services/server/serverRecordRepository';

interface AppLayoutProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  status?: ServerStatus;
}

const navigation: { to: string; label: MessageKey; end?: boolean }[] = [
  { to: '/', label: 'home', end: true },
  { to: '/records', label: 'records' },
  { to: '/analysis', label: 'analysis' },
  { to: '/tat', label: 'tat' },
  { to: '/corrective-actions', label: 'corrective' },
  { to: '/rejected', label: 'rejected' },
  { to: '/system', label: 'system' },
];

export default function AppLayout({ locale, onLocaleChange, status }: AppLayoutProps) {
  const lanEnabled = status?.server.lanEnabled ?? false;
  const storageLabel = status
    ? translate(locale, lanEnabled ? 'serverLanOn' : 'serverLocalOnly')
    : translate(locale, 'serverStarting');

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">TNP</div>
          <div>
            <h1>{translate(locale, 'appTitle')}</h1>
            <p>{translate(locale, 'appSubtitle')}</p>
          </div>
        </div>
        <div className="topbar-tools">
          <span className={`local-badge${lanEnabled ? ' lan-enabled' : ''}`} title={status?.security.warning}>
            <span className="local-dot" />
            {storageLabel}
          </span>
          <label className="language-control">
            <span>{translate(locale, 'language')}</span>
            <select value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}>
              <option value="en">EN</option>
              <option value="vi">VI</option>
              <option value="ko">KO</option>
            </select>
          </label>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label={translate(locale, 'primaryNavigation')}>
          <nav className="nav-list">
            {navigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span className="nav-marker" aria-hidden="true" />
                {translate(locale, item.label)}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
