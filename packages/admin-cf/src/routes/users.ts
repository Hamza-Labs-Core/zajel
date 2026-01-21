/**
 * User management route handlers
 */

import type { Env } from '../types.js';
import { requireAuth, requireSuperAdmin } from './auth.js';

/**
 * List all admin users
 */
export async function handleListUsers(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request('http://do/users', {
    method: 'GET',
    headers: request.headers,
  }));
}

/**
 * Create a new admin user
 */
export async function handleCreateUser(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify super-admin
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request('http://do/users', {
    method: 'POST',
    body: request.body,
    headers: request.headers,
  }));
}

/**
 * Delete an admin user
 */
export async function handleDeleteUser(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  // Verify super-admin
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request(`http://do/users/${userId}`, {
    method: 'DELETE',
    headers: request.headers,
  }));
}
