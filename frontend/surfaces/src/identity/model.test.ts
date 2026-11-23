import { expect, it } from 'vitest';
import {
  createUserSchema,
  updateUserSchema,
  userSchema,
  userQuerySchema,
  defaultUserQuery,
  parseIdentity,
  roleIdsSchema,
} from './model';
it('normalizes user inputs and bounds query, role and credential fields', () => {
  expect(
    createUserSchema.parse({
      name: ' A ',
      email: ' A@EXAMPLE.TEST ',
      password: 'LongPassword2026!',
      roleIds: ['viewer'],
      status: 'active',
    }),
  ).toMatchObject({ name: 'A', email: 'a@example.test' });
  expect(roleIdsSchema.safeParse(['viewer', 'viewer']).success).toBe(false);
  expect(userQuerySchema.safeParse({ ...defaultUserQuery, pageSize: 1000 }).success).toBe(false);
  expect(userQuerySchema.safeParse({ ...defaultUserQuery, page: -1 }).success).toBe(false);
  expect(
    createUserSchema.safeParse({
      name: 'A',
      email: 'invalid',
      password: 'short',
      roleIds: [],
      status: 'active',
    }).success,
  ).toBe(false);
});
it('does not accept credentials or undeclared fields in public user responses', () => {
  const user = {
    id: 'one',
    name: 'One',
    email: 'one@example.test',
    roleIds: ['viewer'],
    status: 'active',
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  expect(parseIdentity(userSchema, user).id).toBe('one');
  expect(() => parseIdentity(userSchema, { ...user, digest: 'private' })).toThrow();
  expect(() => parseIdentity(userSchema, { ...user, version: 0 })).toThrow();
});

it('accepts existing IAM usernames in responses while account writes require email', () => {
  const existing = {
    id: 'owner-one',
    name: 'Owner',
    email: 'owner_01',
    roleIds: ['owner'],
    status: 'active',
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  expect(parseIdentity(userSchema, existing)).toEqual(existing);
  expect(userSchema.safeParse({ ...existing, email: '-owner' }).success).toBe(false);
  expect(
    createUserSchema.safeParse({
      name: existing.name,
      email: existing.email,
      password: 'fixture-password-for-create',
      roleIds: existing.roleIds,
      status: existing.status,
    }).success,
  ).toBe(false);
  expect(
    updateUserSchema.safeParse({
      name: existing.name,
      email: existing.email,
      version: existing.version,
    }).success,
  ).toBe(false);
});
