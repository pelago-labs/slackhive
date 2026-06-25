'use client';

/**
 * @fileoverview Login page — username/password form with optional Slack OAuth.
 *
 * @module web/app/login
 */

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [slackEnabled, setSlackEnabled] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const err = searchParams.get('error');
    if (err === 'slack_denied') setError('Slack sign-in was cancelled.');
    else if (err === 'slack_not_invited') setError('Your Slack account has not been invited. Contact an admin.');
    else if (err) setError('Slack sign-in failed. Please try again.');
  }, [searchParams]);

  useEffect(() => {
    fetch('/api/auth/slack/status')
      .then(r => r.json())
      .then((d: { enabled: boolean }) => setSlackEnabled(d.enabled))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-background">
      <div className="w-[360px] rounded-lg border border-border bg-card px-8 py-9 shadow-lg">
        {/* Logo */}
        <div className="mb-7 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="SlackHive" className="mx-auto mb-3.5 block h-11 w-11 rounded-xl" />
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            SlackHive
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to continue
          </p>
        </div>

        {slackEnabled && (
          <div className="mb-5">
            <a
              href="/api/auth/slack/authorize"
              className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2.5 text-base font-semibold text-foreground no-underline transition-colors hover:border-primary"
            >
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Slack_icon_2019.svg/3840px-Slack_icon_2019.svg.png" width="18" height="18" alt="Slack" />
              Sign in with Slack
            </a>
            <div className="mt-4 flex items-center gap-2.5">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">
              Username
            </Label>
            <Input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">
              Password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/15 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={loading || !username || !password}
            className="mt-1 w-full"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
