'use client';
import { lazy, Suspense, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { WorkspaceProvider } from '../stores/workspace';
import { ReaderWorkspace } from '../src/reader-workspace';
const FileWorkspace = lazy(() =>
  import('../src/file-workspace').then((module) => ({ default: module.FileWorkspace })),
);
function WorkspaceRoute({ children }: { children: ReactNode }) {
  const pathname = usePathname(),
    params = useSearchParams();
  const router = useRouter();
  const file = params.get('file') ?? '';
  const app = params.get('app') ?? '';
  const target =
    pathname === '/home/view' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(file) &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(app)
      ? { fileId: file, application: app }
      : undefined;
  const query = params.toString();
  return (
    <ReaderWorkspace
      pathname={pathname}
      href={pathname + (query ? '?' + query : '')}
      target={target}
      navigate={(href, replace) => {
        if (replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      }}
    >
      <FileWorkspace
        pathname={pathname}
        query={{
          parent: params.get('parent') ?? '',
          category: params.get('category') ?? '',
          trash: params.get('trash') ?? '',
          search: params.get('search') ?? '',
          filter: params.get('filter') ?? '',
          page: params.get('page') ?? '',
          cursor: params.get('cursor') ?? '',
        }}
      >
        {children}
      </FileWorkspace>
    </ReaderWorkspace>
  );
}
export default function FilesLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Suspense>
        <WorkspaceRoute>{children}</WorkspaceRoute>
      </Suspense>
    </WorkspaceProvider>
  );
}
