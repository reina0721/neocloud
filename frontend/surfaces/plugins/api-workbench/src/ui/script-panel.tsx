'use client';
import { useFrontendTranslation } from '@neocloud/i18n';
import { TextAreaField } from '@neocloud/ui-adapter/form-field';
import { DisclosurePanel } from '@neocloud/ui-adapter/disclosure';
export type ScriptPanelProps = Readonly<{
  preScript: string;
  postScript: string;
  onPreScriptChange: (value: string) => void;
  onPostScriptChange: (value: string) => void;
}>;
export function ScriptPanel({
  preScript,
  postScript,
  onPreScriptChange,
  onPostScriptChange,
}: ScriptPanelProps) {
  const { t } = useFrontendTranslation();
  return (
    <div className="grid min-w-0 gap-4">
      <TextAreaField
        label={t('apiWorkbench.scripts.preTitle')}
        content="code"
        rows={8}
        placeholder={t('apiWorkbench.scripts.prePlaceholder')}
        value={preScript}
        onChange={(event) => onPreScriptChange(event.target.value)}
      />
      <TextAreaField
        label={t('apiWorkbench.scripts.postTitle')}
        content="code"
        rows={8}
        placeholder={t('apiWorkbench.scripts.postPlaceholder')}
        value={postScript}
        onChange={(event) => onPostScriptChange(event.target.value)}
      />
      <DisclosurePanel title={t('apiWorkbench.scripts.help')}>
        <p className="break-words font-mono text-xs leading-6">{t('apiWorkbench.scripts.hint')}</p>
      </DisclosurePanel>
    </div>
  );
}
