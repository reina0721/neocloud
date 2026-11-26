import { defaultUserQuery, userQuerySchema, type UserQuery } from '../../../src/identity/model';

export function userListParameters(query: UserQuery): Record<string, string> {
  return {
    q: query.q,
    status: query.status,
    roleId: query.roleId,
    sort: query.sort,
    direction: query.direction,
    page: String(query.page),
    pageSize: String(query.pageSize),
  };
}

/** 只保留列表查询字段。返回链接始终由 users 路由构造。 */
export function userListContext(query: UserQuery | null): string {
  if (!query) return '';
  const standard = userListParameters(defaultUserQuery);
  const overrides = Object.entries(userListParameters(query)).filter(
    ([key, value]) => value !== standard[key],
  );
  return new URLSearchParams(overrides).toString();
}

export function readUserListContext(value: string | null): Record<string, string> {
  if (!value || value.length > 2048) return {};
  const params = new URLSearchParams(value);
  const query = userQuerySchema.safeParse({
    q: params.get('q') ?? defaultUserQuery.q,
    status: params.get('status') ?? defaultUserQuery.status,
    roleId: params.get('roleId') ?? defaultUserQuery.roleId,
    sort: params.get('sort') ?? defaultUserQuery.sort,
    direction: params.get('direction') ?? defaultUserQuery.direction,
    page: params.has('page') ? Number(params.get('page')) : defaultUserQuery.page,
    pageSize: params.has('pageSize') ? Number(params.get('pageSize')) : defaultUserQuery.pageSize,
  });
  if (!query.success) return {};
  return Object.fromEntries(new URLSearchParams(userListContext(query.data)));
}
