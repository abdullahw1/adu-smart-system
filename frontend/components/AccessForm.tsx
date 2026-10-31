"use client";
import { useState, type FormEvent } from 'react';
export function AccessForm({ setup = false, addUser = false }: { setup?: boolean; addUser?: boolean }) {
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [role, setRole] = useState('viewer');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [success, setSuccess] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setSuccess(false);
    try {
      const res = await fetch('/api/auth/' + (addUser ? 'users' : setup ? 'setup' : 'login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password, role }),
      });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Unable to sign in');
      if (addUser) { setSuccess(true); setName(''); setPassword(''); }
      else window.location.assign('/');
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  return <form className="settings-card access-form" onSubmit={submit}>
    <h1>{addUser ? 'Add household access' : setup ? 'Set up your camera system' : 'Sign in to ADU Cameras'}</h1>
    {setup && <p>Create the owner account on the computer running this app. Use this account to manage cameras and invite viewers.</p>}
    <label>Username<input autoComplete="username" value={name} onChange={e => setName(e.target.value)} pattern="[A-Za-z0-9_-]{1,40}" required /></label>
    <label>Password<input type="password" autoComplete={setup || addUser ? 'new-password' : 'current-password'} minLength={setup || addUser ? 12 : undefined} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} required /></label>
    {(setup || addUser) && <p className="hint">Use at least 12 characters.</p>}
    {addUser && <label>Permissions<select value={role} onChange={e => setRole(e.target.value)}><option value="viewer">Viewer — watch and download</option><option value="admin">Administrator — manage cameras and recordings</option></select></label>}
    <button disabled={saving}>{saving ? 'Saving…' : addUser ? 'Add user' : setup ? 'Create owner account' : 'Sign in'}</button>
    {error && <p role="alert" className="error-text">{error}</p>}{success && <p role="status">User added.</p>}
  </form>;
}
