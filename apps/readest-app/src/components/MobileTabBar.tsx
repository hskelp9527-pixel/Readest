'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { PiBooks, PiCompass, PiUser } from 'react-icons/pi';

/**
 * 手机端底部 Tab 栏（对标微信读书：书架 / 找书 / 我的）
 * 仅在 ≤768px 屏幕显示，桌面/平板端隐藏。
 */
const TABS = [
  { key: 'library', label: '书架', path: '/library', icon: PiBooks },
  { key: 'store', label: '找书', path: '/store', icon: PiCompass },
  { key: 'user', label: '我的', path: '/user', icon: PiUser },
] as const;

const MobileTabBar: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav
      className='mobile-tab-bar'
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        display: 'flex',
        background: '#FFFDF8',
        borderTop: '1px solid #E8E1D5',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {TABS.map((tab) => {
        // `/` renders the library page directly, so it must light up 书架.
        const active = (pathname === '/' ? '/library' : pathname)?.startsWith(tab.path);
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            onClick={() => router.push(tab.path)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '8px 0 6px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: active ? '#D97757' : '#96897B',
              fontSize: 11,
              minHeight: 52,
            }}
          >
            <Icon size={22} />
            <span style={{ fontWeight: active ? 600 : 400 }}>{tab.label}</span>
          </button>
        );
      })}
      <style>{`@media (min-width: 769px) { .mobile-tab-bar { display: none !important; } }`}</style>
    </nav>
  );
};

export default MobileTabBar;
