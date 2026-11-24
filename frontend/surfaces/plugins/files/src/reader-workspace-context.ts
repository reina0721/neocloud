import { createContext, useContext } from 'react';
import type { FileEntry } from '../../../src/files/model';
import type { OpenReaderSession } from './file-reader-session';

export const ReaderWorkspaceContext = createContext<{
  foreground: boolean;
  openReader: (entry: FileEntry, application: string, session: OpenReaderSession) => void;
  toggleDock: () => void;
  startMusic: () => void;
  dockOpen: boolean;
  viewerPending: boolean;
  viewerError: string;
  returnToFiles: () => void;
  restoreListPosition: (content: HTMLElement, ready: boolean) => void;
} | null>(null);

export function useReaderWorkspace() {
  const workspace = useContext(ReaderWorkspaceContext);
  if (!workspace) throw new Error('File reader workspace is required');
  return workspace;
}
