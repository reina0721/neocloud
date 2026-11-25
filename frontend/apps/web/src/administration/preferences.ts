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
type SyncIssue = 'read' | 'write' | 'conflict' | 'forbidden';

export type AccountPreferencesStatus = Readonly<{
  values: AccountNotificationPreferences | null;
  editable: boolean;
  sharedReadOnly: boolean;
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

export function createAccountPreferencesSync({
  port,
  ownsAccount,
  writable,
  publish,
}: Readonly<{
  port: Pick<AdministrationPort, 'preferences' | 'savePreferences'>;
  ownsAccount: () => boolean;
  writable: boolean;
  publish: (status: AccountPreferencesStatus) => void;
}>) {
  const lifetime = new AbortController();
  const current = () => ownsAccount() && !lifetime.signal.aborted;
  let server: AccountPreferences | undefined;
  let draft: AccountChange = {};
  let sending: AccountChange | undefined;
  let conflictFields = new Set<keyof AccountFields>();
  let conflictBase: AccountPreferences | undefined;
  let rebased = false;
  let issue: SyncIssue | null = null;
  let readDenied = false;
  let writeDenied = false;
  let reading = false;
  let writing = false;
  let queued = false;

  function reflect() {
    if (!current()) return;
    const editable = writable && !writeDenied && !readDenied;
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
      sharedReadOnly: !readDenied && !editable,
      pending: !issue && (writing || Object.keys(draft).length > 0),
      issue,
    });
  }

  function schedule() {
    if (
      queued ||
      !current() ||
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
    if (!current() || reading || writing) return;
    reading = true;
    try {
      const value = await port.preferences(lifetime.signal);
      if (!current()) return;
      readDenied = false;
      if (server && server.version !== value.version && Object.keys(draft).length)
        conflictBase ??= server;
      acceptLatest(value);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 403) {
        readDenied = true;
        server = undefined;
        issue = 'forbidden';
      } else {
        issue = 'read';
      }
    } finally {
      reading = false;
      reflect();
      schedule();
    }
  }

  function acceptLatest(latest: AccountPreferences) {
    server = latest;
    issue = null;
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
    if (!current() || issue || reading || writing || !server || !Object.keys(draft).length) return;
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
      if (current()) {
        server = saved;
        rebased = false;
      }
    } catch (error) {
      if (!current()) return;
      draft = { ...sending, ...draft };
      if (error instanceof ApiError && error.status === 409) {
        conflictBase = prior;
        try {
          const latest = await port.preferences(lifetime.signal);
          if (current()) acceptLatest(latest);
        } catch {
          if (current()) issue = 'read';
        }
      } else {
        writeDenied = error instanceof ApiError && error.status === 403;
        issue = writeDenied ? 'forbidden' : 'write';
      }
    } finally {
      writing = false;
      sending = undefined;
      reflect();
      schedule();
    }
  }

  function queue(changes: AccountChange) {
    if (!current() || !writable || writeDenied || readDenied || !Object.keys(changes).length)
      return;
    draft = { ...draft, ...changes };
    reflect();
    if (!server && !issue) void load();
    schedule();
  }

  return {
    load,
    refresh: () => {
      if (!issue && !queued && !Object.keys(draft).length) void load();
    },
    accept: (before: Preferences, after: Preferences) => {
      if (!current() || readDenied) return false;
      if (!writable || writeDenied) return true;
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
      if (issue === 'read' || issue === 'forbidden') {
        writeDenied = false;
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
      issue = null;
      reflect();
      schedule();
    },
    dispose: () => lifetime.abort(),
  };
}
