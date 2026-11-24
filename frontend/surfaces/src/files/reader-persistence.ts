/** 只保存可重新授权的文件标识、应用标识及本机草稿。 */
export type ReaderBookmark = Readonly<{
  fileId: string;
  application: string;
  position?: number;
  shelf?: 'video';
}>;

export type ReaderDraft = Readonly<{
  revision: number;
  payload: unknown;
}>;

export type ReaderDraftHandle = Readonly<{
  read: () => Promise<ReaderDraft | undefined>;
  write: (draft: ReaderDraft) => Promise<void>;
  clear: () => Promise<void>;
  download: (name: string, data: string | ArrayBuffer, type: string) => void;
  guard: (message: string) => () => void;
}>;

export type ReaderPersistence = Readonly<{
  read: () => Promise<readonly ReaderBookmark[]>;
  write: (bookmarks: readonly ReaderBookmark[]) => Promise<void>;
  hasDraft: (fileId: string, application: string) => Promise<boolean>;
  draft: (fileId: string, application: string) => ReaderDraftHandle;
}>;
