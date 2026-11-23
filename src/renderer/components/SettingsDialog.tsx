import type { ReactNode } from 'react';
import { useAppStore } from '../stores/app.js';
import { ScrimDialog } from './Overlays.js';
import { SettingsNavigation } from './SettingsNavigation.js';
import { UiIcon } from './UiIcon.js';

export function SettingsDialog({ children }: { children: ReactNode }) {
  const view = useAppStore(s => s.settingsView);
  const close = useAppStore(s => s.closeSettings);
  return <ScrimDialog title="设置" className="settings-dialog" onClose={close}>
    <button className="dialog-close icon-btn" aria-label="关闭设置" onClick={close}><UiIcon name="close"/></button>
    <div className="settings-layout">
      <SettingsNavigation/>
      <div id="settings-content" className="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${view}`} tabIndex={0}>
        {children}
      </div>
    </div>
  </ScrimDialog>;
}
