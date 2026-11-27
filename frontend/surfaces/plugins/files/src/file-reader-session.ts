import type { FileEntry, FilesPort } from '../../../src/files/model';
import { isHlsPlaylist } from '../../../src/files/model';
import { isPDFDocument, type FileDocumentProps } from '../../../src/files/pdf-contract';
import { isEpubDocument } from '../../../src/files/epub-contract';
import { isMarkdownFile } from '../../../src/files/markdown';
import { fileIconExtension } from '../../../src/files/icon-rules';
import {
  isTextPreview,
  fileApplicationChoice,
  type FileApplicationID,
  type FileApplicationPolicy,
  type WebFileApplicationItem,
} from '../../../src/files/file-applications';
import type { TextRequest } from './text-dialog';
import type { DrawioRequest } from './drawio-dialog';
import type { VideoPlaybackHandoff } from '../../../src/files/runtime';

export const archiveFile = (entry: FileEntry) =>
  entry.kind === 'file' &&
  (/\.(zip|7z)$/i.test(entry.name) ||
    entry.mediaType === 'application/zip' ||
    entry.mediaType === 'application/x-7z-compressed');

export function compatibleFileApplications(
  entry: FileEntry,
  builtInText: boolean,
): FileApplicationID[] {
  if (archiveFile(entry)) return ['archive'];
  if (isPDFDocument(entry)) return ['pdf'];
  if (isEpubDocument(entry)) return ['epub'];
  if (isMarkdownFile(entry)) return ['markdown', 'text'];
  if (isHlsPlaylist(entry)) return ['video'];
  const media = entry.mediaType.split('/', 1)[0];
  if (fileIconExtension(entry.name) === 'drawio') return ['drawio'];
  if (media === 'image' || media === 'audio' || media === 'video') return [media];
  return isTextPreview(entry) || builtInText ? ['text'] : [];
}

export function configuredFileApplications(entry: FileEntry): FileApplicationID[] {
  const options: FileApplicationID[] = ['pdf', 'epub', 'markdown', 'text', 'drawio'];
  if (archiveFile(entry)) options.push('archive');
  const media = entry.mediaType.split('/', 1)[0];
  if (media === 'image' || media === 'audio' || media === 'video') options.push(media);
  if (isHlsPlaylist(entry) && !options.includes('video')) options.push('video');
  return options;
}

export type FileApplicationPicker = Readonly<{
  entry: FileEntry;
  options?: readonly FileApplicationID[];
  webOptions?: readonly WebFileApplicationItem[];
  policy?: FileApplicationPolicy;
  error?: string;
}>;

export type MediaReaderSession = {
  kind: 'media';
  entry: FileEntry;
  maxBytes: number;
  videoPlaylist?: true;
  videoHandoff?: VideoPlaybackHandoff;
  openImageEditor?: boolean;
  savedImageVersion?: boolean;
  album?: { entries: readonly FileEntry[]; index: number };
};

/** 阅读会话只允许一个应用；预算与文件快照属于会话，不随列表刷新改变。 */
export type FileReaderSession =
  | ({ kind: 'selecting'; scope: string; visible: boolean } & FileApplicationPicker)
  | { kind: 'text'; request: TextRequest; maxBytes: number }
  | { kind: 'drawio'; request: DrawioRequest; maxBytes: number }
  | ({ kind: 'pdf' } & Pick<FileDocumentProps, 'entry' | 'limits' | 'initialPosition'>)
  | { kind: 'epub'; entry: FileEntry }
  | { kind: 'archive'; entry: FileEntry }
  | MediaReaderSession
  | { kind: 'web'; entry: FileEntry; application: WebFileApplicationItem };

export type OpenReaderSession = Exclude<FileReaderSession, { kind: 'selecting' }>;
export type ReaderApplication = FileApplicationID | WebFileApplicationItem;
export type ReaderLimits = Readonly<{
  maxTextBytes: number | undefined;
  maxMediaBytes: number | undefined;
  pdfReader: FileDocumentProps['limits'] | undefined;
}>;

export function readerApplications(
  policy: FileApplicationPolicy,
  entry: FileEntry,
  device: 'desktop' | 'mobile',
) {
  const extension = fileIconExtension(entry.name);
  const builtInText = policy.items.some(
    (item) => item.id === 'text' && !item.customExtensions && item.extensions.includes(extension),
  );
  return {
    choice: fileApplicationChoice(
      policy,
      compatibleFileApplications(entry, builtInText),
      configuredFileApplications(entry),
      extension,
      device,
    ),
    web: policy.webItems.filter(
      (app) =>
        app.enabled &&
        app.origin &&
        app.extensions.includes(extension) &&
        (app.platform === 'all' || app.platform === device),
    ),
  };
}

export function defaultReaderApplication({ choice, web }: ReturnType<typeof readerApplications>) {
  const external =
    web.find((app) => app.id === choice.defaultApp) ??
    (web.length === 1 && choice.options.length === 0 ? web[0] : undefined);
  return (
    external ??
    (web.length ? choice.options.find((id) => id === choice.defaultApp) : choice.automatic)
  );
}

export function makeReaderSession(
  entry: FileEntry,
  application: ReaderApplication,
  limits: ReaderLimits,
  options: { plainEdit?: boolean; album?: MediaReaderSession['album'] } = {},
): OpenReaderSession | undefined {
  if (typeof application !== 'string') return { kind: 'web', entry, application };
  switch (application) {
    case 'archive':
    case 'epub':
      return { kind: application, entry };
    case 'pdf':
      return limits.pdfReader ? { kind: 'pdf', entry, limits: limits.pdfReader } : undefined;
    case 'drawio':
      return limits.maxTextBytes !== undefined && entry.trashedAt === null
        ? { kind: 'drawio', request: { entry }, maxBytes: limits.maxTextBytes }
        : undefined;
    case 'markdown':
    case 'text':
      return limits.maxTextBytes === undefined
        ? undefined
        : {
            kind: 'text',
            request: {
              mode: 'edit',
              entry,
              ...(options.plainEdit
                ? {}
                : application === 'markdown'
                  ? { reading: true }
                  : { code: true }),
            },
            maxBytes: limits.maxTextBytes,
          };
    default:
      return limits.maxMediaBytes === undefined
        ? undefined
        : {
            kind: 'media',
            entry,
            maxBytes: limits.maxMediaBytes,
            ...(options.album ? { album: options.album } : {}),
            ...(application === 'video' && entry.trashedAt === null && isHlsPlaylist(entry)
              ? { videoPlaylist: true }
              : {}),
          };
  }
}

export function readReaderLimits(port: FilesPort, signal: AbortSignal) {
  return port.list(
    {
      parent: '',
      category: '',
      search: '',
      trash: false,
      sort: 'name',
      desc: false,
      page: 1,
      pageSize: 1,
      pagination: 'numbered',
    },
    signal,
  );
}
