/**
 * Users tab - port of existing inline dashboard.
 */
import { useState } from 'preact/hooks';
import { useFetch } from '../hooks';
import { api } from '../api';

interface AdminUser {
  id: string;
  username: string;
  role: string;
  lastLogin: string | null;
}

interface Props {
  user: { userId: string; username: string; role: string };
}

export function UsersTab({ user }: Props) {
  const { data: users, loading, refetch } = useFetch<AdminUser[]>('/admin/api/users', 0);
  const [error, setError] = useState<string | null>(null);
  const canManage = user.role === 'super-admin';

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const form = e.target as HTMLFormElement;
    const username = (form.elements.namedItem('new-username') as HTMLInputElement).value;
    const password = (form.elements.namedItem('new-password') as HTMLInputElement).value;
    const role = (form.elements.namedItem('new-role') as HTMLSelectElement).value;

    const res = await api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    });
    if (res.success) {
      form.reset();
      await refetch();
    } else {
      setError(res.error || 'Failed to create user');
    }
  };

  const handleDelete = async (userId: string) => {
    const res = await api(`/admin/api/users/${userId}`, { method: 'DELETE' });
    if (res.success) {
      await refetch();
    } else {
      setError(res.error || 'Failed to delete user');
    }
  };

  if (loading) {
    return <div class="loading"><div class="spinner" /></div>;
  }

  return (
    <div>
      {canManage && (
        <div class="panel">
          <h3>Add New Admin</h3>
          <form onSubmit={handleCreate}>
            <div class="form-row">
              <div class="form-group">
                <label for="new-username">Username</label>
                <input type="text" id="new-username" name="new-username" required minLength={3} />
              </div>
              <div class="form-group">
                <label for="new-password">Password</label>
                <input type="password" id="new-password" name="new-password" required minLength={12} />
              </div>
              <div class="form-group">
                <label for="new-role">Role</label>
                <select id="new-role" name="new-role">
                  <option value="admin">Admin</option>
                  <option value="super-admin">Super Admin</option>
                </select>
              </div>
            </div>
            <button type="submit" style={{ marginTop: '1rem' }}>Add User</button>
            {error && <p class="error-message">{error}</p>}
          </form>
        </div>
      )}

      <div class="user-list">
        {(users || []).map(u => (
          <div key={u.id} class="user-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span>{u.username}</span>
              <span class="role-badge">{u.role}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Last login: {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : 'Never'}
              </span>
              {canManage && u.id !== user.userId && (
                <button class="danger" onClick={() => handleDelete(u.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
