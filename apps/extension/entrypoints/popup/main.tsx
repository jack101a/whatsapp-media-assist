import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { getSettings, updateSettings, watchSettings, type AppSettings } from '../../src/storage/settings';
import { Icon } from '../../src/components/Icon';
import './popup.css';

function Popup() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);

  if (!settings) return <main className="popup"><div className="loading">Loading…</div></main>;

  const toggle = async () => {
    const next = await updateSettings({ enabled: !settings.enabled });
    setSettings(next);
  };

  return <main className="popup">
    <header className="brand">
      <img src="/icons/icon-48.png" alt="" />
      <div><strong>WhatsApp Media Assist</strong><span>WhatsApp Web media tools</span></div>
    </header>

    <button className="toggle-row" type="button" onClick={() => void toggle()} aria-pressed={settings.enabled}>
      <span><b>Extension</b><small>{settings.enabled ? 'Enabled on WhatsApp Web' : 'Paused'}</small></span>
      <span className={`switch${settings.enabled ? ' on' : ''}`} aria-hidden="true"><i /></span>
    </button>

    <button className="settings-button" type="button" onClick={() => void browser.runtime.openOptionsPage()}>
      <Icon name="settings" size={19} />
      <span>Open settings</span>
      <span className="arrow">›</span>
    </button>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Popup />);
