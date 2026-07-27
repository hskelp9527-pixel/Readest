import clsx from 'clsx';
import React, { useState } from 'react';
import { PiSun, PiMoon } from 'react-icons/pi';
import { TbSunMoon } from 'react-icons/tb';

import { isTauriAppPlatform } from '@/services/environment';
import { useEnv } from '@/context/EnvContext';
import { useThemeStore } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { tauriHandleSetAlwaysOnTop, tauriHandleToggleFullScreen } from '@/utils/window';
import { saveSysSettings } from '@/helpers/settings';
import MenuItem from '@/components/MenuItem';
import Menu from '@/components/Menu';

/**
 * Account, Settings, Advanced Settings, Download and About were removed from this
 * fork: it deploys as a static site with no auth or sync backend, so those rows
 * either dead-ended or advertised the upstream app. What is left is the theme
 * cycle plus the desktop window toggles, which are all platform-gated anyway.
 */
interface SettingsMenuProps {
  // Kept so LibraryHeader's call site is unchanged; nothing in this menu pulls
  // the library any more.
  onPullLibrary: (fullRefresh?: boolean, verbose?: boolean) => void;
  setIsDropdownOpen?: (isOpen: boolean) => void;
}

const SettingsMenu: React.FC<SettingsMenuProps> = ({ setIsDropdownOpen }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { themeMode, setThemeMode } = useThemeStore();
  const { settings } = useSettingsStore();
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(settings.alwaysOnTop);
  const [isAlwaysShowStatusBar, setIsAlwaysShowStatusBar] = useState(settings.alwaysShowStatusBar);
  const [isOpenLastBooks, setIsOpenLastBooks] = useState(settings.openLastBooks);
  const [isAutoImportBooksOnOpen, setIsAutoImportBooksOnOpen] = useState(
    settings.autoImportBooksOnOpen,
  );

  const cycleThemeMode = () => {
    const nextMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
    setThemeMode(nextMode);
  };

  const handleFullScreen = () => {
    tauriHandleToggleFullScreen();
    setIsDropdownOpen?.(false);
  };

  const toggleOpenInNewWindow = () => {
    saveSysSettings(envConfig, 'openBookInNewWindow', !settings.openBookInNewWindow);
    setIsDropdownOpen?.(false);
  };

  const toggleAlwaysOnTop = () => {
    const newValue = !settings.alwaysOnTop;
    saveSysSettings(envConfig, 'alwaysOnTop', newValue);
    setIsAlwaysOnTop(newValue);
    tauriHandleSetAlwaysOnTop(newValue);
    setIsDropdownOpen?.(false);
  };

  const toggleAlwaysShowStatusBar = () => {
    const newValue = !settings.alwaysShowStatusBar;
    saveSysSettings(envConfig, 'alwaysShowStatusBar', newValue);
    setIsAlwaysShowStatusBar(newValue);
  };

  const toggleAutoImportBooksOnOpen = () => {
    const newValue = !settings.autoImportBooksOnOpen;
    saveSysSettings(envConfig, 'autoImportBooksOnOpen', newValue);
    setIsAutoImportBooksOnOpen(newValue);
  };

  const toggleOpenLastBooks = () => {
    const newValue = !settings.openLastBooks;
    saveSysSettings(envConfig, 'openLastBooks', newValue);
    setIsOpenLastBooks(newValue);
  };

  const themeModeLabel =
    themeMode === 'dark'
      ? _('Dark Mode')
      : themeMode === 'light'
        ? _('Light Mode')
        : _('Auto Mode');

  return (
    <Menu
      className={clsx(
        'settings-menu dropdown-content no-triangle',
        'z-20 mt-2 max-w-[90vw] shadow-2xl',
      )}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      {isTauriAppPlatform() && (
        <MenuItem
          label={_('Auto Import on File Open')}
          toggled={isAutoImportBooksOnOpen}
          onClick={toggleAutoImportBooksOnOpen}
        />
      )}
      {isTauriAppPlatform() && (
        <MenuItem
          label={_('Open Last Book on Start')}
          toggled={isOpenLastBooks}
          onClick={toggleOpenLastBooks}
        />
      )}
      {appService?.hasWindow && (
        <MenuItem
          label={_('Open Book in New Window')}
          toggled={settings.openBookInNewWindow}
          onClick={toggleOpenInNewWindow}
        />
      )}
      {appService?.hasWindow && <MenuItem label={_('Fullscreen')} onClick={handleFullScreen} />}
      {appService?.hasWindow && (
        <MenuItem label={_('Always on Top')} toggled={isAlwaysOnTop} onClick={toggleAlwaysOnTop} />
      )}
      {appService?.isMobileApp && (
        <MenuItem
          label={_('Always Show Status Bar')}
          toggled={isAlwaysShowStatusBar}
          onClick={toggleAlwaysShowStatusBar}
        />
      )}
      <MenuItem
        label={themeModeLabel}
        Icon={themeMode === 'dark' ? PiMoon : themeMode === 'light' ? PiSun : TbSunMoon}
        onClick={cycleThemeMode}
      />
    </Menu>
  );
};

export default SettingsMenu;
