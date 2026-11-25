import type {
  AccountNotificationPreferences,
  AccountPreferences,
  AccountPreferencesPatch,
  AdministrationPort,
} from '@clouddrive/surface/administration';
import type { Preferences } from '@clouddrive/surface/preferences-model';
import { ApiError } from '../api/json-client';
import { useShellStore } from '../state/use-shell-store';

type AccountFields = Pick<AccountPreferences, 'language' | 'timeZone' | 'themeMode'> &
  AccountPreferences['notifications'];
type AccountChange = Partial<AccountFields>;
type SyncIssue = 'read' | 'write' | 'conflict' | 'forbidden' | 'rejected';
export type AccountPreferencesAccess = 'unavailable' | 'device' | 'read-only' | 'writable';

export type AccountPreferencesStatus = Readonly<{
  values: AccountNotificationPreferences | null;
  editable: boolean;
  sharedReadOnly: boolean;
  sharedUnavailable: boolean;
  pending: boolean;
  issue: SyncIssue | null;
}>;

const accountFields = [
  'language',
  'timeZone',
  'themeMode',
  'inApp',
  'emailDigest',
  'showSummaries',
  'dailySummary',
] as const satisfies readonly (keyof AccountFields)[];

function localFields(value: Preferences) {
  return {
    language: value.localeRegion.language === 'en' ? 'en-US' : 'zh-CN',
    timeZone: value.localeRegion.timeZone === 'auto' ? '' : value.localeRegion.timeZone,
    themeMode: value.appearance.themeMode,
    inApp: value.notifications.inAppNotifications,
  } as const;
}

function storedFields(value: AccountPreferences): AccountFields {
  return {
    language: value.language,
    timeZone: value.timeZone,
    themeMode: value.themeMode,
    ...value.notifications,
  };
}

function selectChanges(changes: AccountChange, include: (key: keyof AccountFields) => boolean) {
  return Object.fromEntries(
    accountFields.filter((key) => key in changes && include(key)).map((key) => [key, changes[key]]),
  ) as AccountChange;
}

function patchOf(version: number, value: AccountChange): AccountPreferencesPatch {
  const { language, timeZone, themeMode, ...notifications } = value;
  return {
    version,
    ...(language !== undefined ? { language } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(themeMode !== undefined ? { themeMode } : {}),
    ...(Object.keys(notifications).length ? { notifications } : {}),
  };
}

function isNativePermissionDenial(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const problem = error.payload;
  return (
    typeof problem === 'object' &&
    problem !== null &&
    'code' in problem &&
    problem.code === 'permission_denied'
  );
}

export function createAccountPreferencesSync({
  port,
  ownsAccount,
  refreshAccess,
  publish,
}: Readonly<{
  port: Pick<AdministrationPort, 'preferences' | 'savePreferences'>;
  ownsAccount: () => boolean;
  refreshAccess: () => void;
  publish: (status: AccountPreferencesStatus) => void;
}>) {
  const lifetime = new AbortController();
  const current = () => ownsAccount() && !lifetime.signal.aborted;
  let access: AccountPreferencesAccess = 'unavailable';
  const canRead = () => access === 'read-only' || access === 'writable';
  const canWrite = () => access === 'writable';
  let server: AccountPreferences | undefined;
  let draft: AccountChange = {};
  let sending: AccountChange | undefined;
  let conflictFields = new Set<keyof AccountFields>();
  let conflictBase: AccountPreferences | undefined;
  let rebased = false;
  let issue: SyncIssue | null = null;
  let writePermissionDenied = false;
  let reading = false;
  let writing = false;
  let queued = false;

  function reflect() {
    if (!current()) return;
    const editable = canWrite();
    const desired = { ...sending, ...draft };
    const preferences = {
      ...(server && server.version > 0 ? storedFields(server) : {}),
      ...(editable ? desired : {}),
    };
    const overlay = {
      ...(preferences.language !== undefined
        ? { language: preferences.language === 'en-US' ? ('en' as const) : ('zh-CN' as const) }
        : {}),
      ...(preferences.timeZone !== undefined ? { timeZone: preferences.timeZone || 'auto' } : {}),
      ...(preferences.themeMode !== undefined ? { themeMode: preferences.themeMode } : {}),
      ...(preferences.inApp !== undefined ? { inAppNotifications: preferences.inApp } : {}),
    };
    const state = useShellStore.getState();
    const projection = Object.keys(overlay).length ? overlay : undefined;
    if (JSON.stringify(state.accountPreferences) !== JSON.stringify(projection))
      state.applyAccountPreferences(projection);
    const notifications = server ? { ...server.notifications, ...(editable ? desired : {}) } : null;
    publish({
      values: notifications
        ? {
            emailDigest: notifications.emailDigest,
            showSummaries: notifications.showSummaries,
            dailySummary: notifications.dailySummary,
          }
        : null,
      editable,
      sharedReadOnly: access === 'read-only',
      sharedUnavailable: access === 'unavailable',
      pending: editable && !issue && (writing || Object.keys(draft).length > 0),
      issue,
    });
  }

  function schedule() {
    if (
      queued ||
      !current() ||
      !canWrite() ||
      issue ||
      reading ||
      writing ||
      !server ||
      !Object.keys(draft).length
    )
      return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void flush();
    });
  }

  async function load() {
    if (!current() || !canRead() || reading || writing) return;
    reading = true;
    try {
      const value = await port.preferences(lifetime.signal);
      if (!current() || !canRead()) return;
      if (server && server.version !== value.version && Object.keys(draft).length)
        conflictBase ??= server;
      acceptLatest(value);
    } catch (error) {
      if (current() && canRead()) failRead(error);
    } finally {
      reading = false;
      reflect();
      schedule();
    }
  }

  function failRead(error: unknown) {
    writePermissionDenied = false;
    if (isNativePermissionDenial(error)) {
      server = undefined;
      issue = 'forbidden';
      refreshAccess();
    } else {
      issue = 'read';
    }
  }

  function acceptLatest(latest: AccountPreferences) {
    server = latest;
    issue = null;
    writePermissionDenied = false;
    if (!conflictBase) return;
    const original = storedFields(conflictBase);
    conflictBase = undefined;
    const currentValues = storedFields(latest);
    draft = selectChanges(draft, (key) => draft[key] !== currentValues[key]);
    conflictFields = new Set(
      accountFields.filter((key) => key in draft && original[key] !== currentValues[key]),
    );
    if (conflictFields.size || (rebased && Object.keys(draft).length)) {
      issue = 'conflict';
      if (!conflictFields.size)
        conflictFields = new Set(accountFields.filter((key) => key in draft));
    }
    rebased = Object.keys(draft).length > 0;
  }

  async function flush() {
    if (
      !current() ||
      !canWrite() ||
      issue ||
      reading ||
      writing ||
      !server ||
      !Object.keys(draft).length
    )
      return;
    const prior = server;
    const original = storedFields(prior);
    sending = selectChanges(draft, (key) => prior.version === 0 || draft[key] !== original[key]);
    draft = {};
    if (!Object.keys(sending).length) {
      sending = undefined;
      reflect();
      return;
    }
    writing = true;
    reflect();
    try {
      const values =
        prior.version === 0
          ? { ...localFields(useShellStore.getState().preferences), ...sending }
          : sending;
      const saved = await port.savePreferences(patchOf(prior.version, values), lifetime.signal);
      if (current() && canRead()) {
        server = saved;
        rebased = false;
      }
    } catch (error) {
      if (!current()) return;
      draft = { ...sending, ...draft };
      if (error instanceof ApiError && error.status === 409) {
        conflictBase = prior;
        if (!canRead()) {
          issue = 'read';
          return;
        }
        try {
          const latest = await port.preferences(lifetime.signal);
          if (current() && canRead()) acceptLatest(latest);
        } catch (readError) {
          if (current() && canRead()) failRead(readError);
        }
      } else if (isNativePermissionDenial(error)) {
        issue = 'forbidden';
        writePermissionDenied = true;
        refreshAccess();
      } else {
        issue = error instanceof ApiError && error.status === 403 ? 'rejected' : 'write';
      }
    } finally {
      writing = false;
      sending = undefined;
      reflect();
      schedule();
    }
  }

  function queue(changes: AccountChange) {
    if (!current() || !canWrite() || !Object.keys(changes).length) return;
    draft = { ...draft, ...changes };
    reflect();
    if (!server && !issue) void load();
    schedule();
  }

  return {
    load,
    setAccess: (next: AccountPreferencesAccess) => {
      if (!current()) return;
      access = next;
      if (!canRead()) server = undefined;
      reflect();
      schedule();
    },
    refresh: () => {
      if (!issue && !queued && (!server || !Object.keys(draft).length)) void load();
    },
    accept: (before: Preferences, after: Preferences) => {
      if (!current() || access === 'device') return false;
      if (!canWrite()) return true;
      const previous: AccountChange = localFields(before);
      const next: AccountChange = localFields(after);
      queue(selectChanges(next, (key) => previous[key] !== next[key]));
      return true;
    },
    updateNotification: (field: keyof AccountNotificationPreferences, value: boolean) => {
      queue({ [field]: value });
    },
    retry: () => {
      if (!current() || reading || writing) return;
      if (issue === 'forbidden') refreshAccess();
      if (
        !canWrite() &&
        (writePermissionDenied || issue === 'write' || issue === 'rejected' || issue === 'conflict')
      )
        return;
      if (issue === 'read' || issue === 'forbidden' || !server) {
        void load();
        return;
      }
      conflictFields.clear();
      rebased = false;
      issue = null;
      reflect();
      schedule();
    },
    dismiss: () => {
      draft = issue === 'conflict' ? selectChanges(draft, (key) => !conflictFields.has(key)) : {};
      conflictFields.clear();
      conflictBase = undefined;
      rebased = false;
      writePermissionDenied = false;
      issue = null;
      reflect();
      schedule();
    },
    dispose: () => lifetime.abort(),
  };
}
