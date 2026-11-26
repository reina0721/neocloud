'use client';

import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { CheckboxField, SelectField } from '@clouddrive/ui-adapter/form-field';
import { FilesError, type FileEntry } from '../../../src/files/model';
import { useFiles } from '../../../src/files/runtime';
import {
  textEncodings,
  type FileTextSource,
  type TextEncoding,
} from '../../../src/files/text-editor';
import { MarkdownPreview } from './markdown-preview';

type PreviewFile = { entry: FileEntry; textEditable?: boolean };

type TextRead = {
  signal: AbortSignal;
  source: FileTextSource;
  encoding: TextEncoding;
  text: string | undefined;
  decodingFailed: boolean;
};

function decode(source: FileTextSource, encoding: TextEncoding): string | undefined {
  try {
    return source.decode(encoding).text;
  } catch (error) {
    if (error instanceof FilesError && (error.code === 'invalid' || error.code === 'unsupported'))
      return undefined;
    throw error;
  }
}

export function TextQuickPreview({
  entry,
  markdown,
  maxBytes,
  textEditable,
  signal,
  pending,
  onReady,
  onFailure,
}: {
  entry: FileEntry;
  markdown: boolean;
  maxBytes: number;
  textEditable?: boolean;
  signal: AbortSignal;
  pending?: ReactNode;
  onReady: (detail: PreviewFile) => void;
  onFailure: (error: unknown) => void;
}) {
  const port = useFiles();
  const { t } = useFrontendTranslation();
  const [reading, setReading] = useState<TextRead>();
  const [wrapped, setWrapped] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [chooseEncoding, setChooseEncoding] = useState(false);
  const encodingId = useId();
  const reportReady = useEffectEvent(() => onReady({ entry, textEditable: textEditable === true }));
  const reportFailure = useEffectEvent(onFailure);

  useEffect(() => {
    const controller = new AbortController();
    const scoped = AbortSignal.any([signal, controller.signal]);
    void (async () => {
      try {
        scoped.throwIfAborted();
        if (entry.sizeBytes > maxBytes) throw new FilesError('large');
        const source = await port.openTextSource(entry, scoped);
        scoped.throwIfAborted();
        const text = decode(source, 'auto');
        setReading({
          signal,
          source,
          encoding: 'auto',
          text,
          decodingFailed: text === undefined,
        });
        reportReady();
      } catch (error) {
        if (!scoped.aborted) reportFailure(error);
      }
    })();
    return () => controller.abort();
  }, [entry, maxBytes, port, signal]);

  if (!reading || reading.signal !== signal) return pending;
  const renderMarkdown = markdown && !showSource;
  const encodingVisible = chooseEncoding || reading.decodingFailed;

  function changeEncoding(value: string) {
    const option = textEncodings.find(([encoding]) => encoding === value);
    if (!option || !reading || signal.aborted) return;
    try {
      const text = decode(reading.source, option[0]);
      setReading({
        ...reading,
        encoding: option[0],
        text: text ?? reading.text,
        decodingFailed: text === undefined,
      });
      setChooseEncoding(true);
    } catch (error) {
      if (!signal.aborted) onFailure(error);
    }
  }

  return (
    <div className="min-w-0" data-file-text-preview>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1">
        {markdown && reading.text !== undefined ? (
          <Action size="sm" variant="quiet" onPress={() => setShowSource(!showSource)}>
            {t(`files.textQuickPreview.${showSource ? 'showRendered' : 'showSource'}`)}
          </Action>
        ) : null}
        {!renderMarkdown && reading.text !== undefined ? (
          <div className="w-fit">
            <CheckboxField
              label={t('files.textQuickPreview.wrap')}
              checked={wrapped}
              onCheckedChange={setWrapped}
            />
          </div>
        ) : null}
        {!reading.decodingFailed ? (
          <Action
            size="sm"
            variant="quiet"
            expanded={encodingVisible}
            {...(encodingVisible ? { controls: encodingId } : {})}
            onPress={() => setChooseEncoding((visible) => !visible)}
          >
            {t('files.textQuickPreview.encodingOptions')}
          </Action>
        ) : null}
        {encodingVisible ? (
          <div id={encodingId}>
            <SelectField
              label={t('files.textQuickPreview.encoding')}
              presentation="toolbar"
              value={reading.encoding}
              onValueChange={changeEncoding}
              options={textEncodings.map(([value, label]) => ({
                value,
                label: value === 'auto' ? t('files.textQuickPreview.automatic') : label,
              }))}
            />
          </div>
        ) : null}
      </div>
      {reading.decodingFailed ? (
        <p role="alert" className="px-4 pt-3 text-sm text-danger">
          {t('files.textQuickPreview.decodingFailure')}
        </p>
      ) : null}
      {reading.text === undefined ? null : renderMarkdown ? (
        <MarkdownPreview
          compact
          text={reading.text}
          parentId={entry.parentId}
          signal={signal}
          labels={{
            preview: t('files.textQuickPreview.markdownPreview'),
            empty: t('files.textQuickPreview.empty'),
            tooLarge: t('files.textQuickPreview.markdownTooLarge'),
            failed: t('files.textQuickPreview.markdownFailure'),
            missingImage: t('files.textQuickPreview.missingImage'),
          }}
        />
      ) : reading.text ? (
        <pre
          aria-label={t('files.textContent')}
          className={`m-0 p-4 font-mono text-sm text-ink ${wrapped ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre'}`}
        >
          {reading.text}
        </pre>
      ) : (
        <p className="p-4 text-sm text-ink-muted">{t('files.textQuickPreview.empty')}</p>
      )}
    </div>
  );
}
