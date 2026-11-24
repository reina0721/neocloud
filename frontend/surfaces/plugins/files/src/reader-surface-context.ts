import { createContext, useContext } from 'react';
import type { FileEntry } from '../../../src/files/model';
import type { ReaderDraftHandle } from '../../../src/files/runtime';

export type ViewerPresentation = 'reader' | 'mini' | 'parked';
export type ViewerDraftState = 'clean' | 'saving' | 'saved' | 'failed';

export const ReaderSurfaceContext = createContext<{
  entry: FileEntry;
  presentation: ViewerPresentation;
  video: boolean;
  closeSequence: number;
  minimize: () => void;
  returnToFiles: () => void;
  openFolder: () => void;
  restore: () => void;
  close: () => void;
  interceptClose: (request: () => void) => () => void;
  requestInterceptedClose: () => boolean;
  download: () => void;
  draft: ReaderDraftHandle | undefined;
  draftState: ViewerDraftState;
  setDraftState: (state: ViewerDraftState) => void;
} | null>(null);

export function useReaderSurface() {
  return useContext(ReaderSurfaceContext);
}
