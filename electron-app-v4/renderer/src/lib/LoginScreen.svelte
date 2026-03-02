<script>
  import { createEventDispatcher } from 'svelte';
  import { login } from '../api.js';
  import { currentUser } from '../stores.js';

  const dispatch = createEventDispatcher();

  let username = '';
  let password = '';
  let error    = '';
  let loading  = false;

  async function doLogin() {
    if (!username || !password) return;
    loading = true;
    error   = '';
    try {
      const user = await login(username, password);
      currentUser.set(user);
      password = '';
      dispatch('loggedin');
    } catch (e) {
      error = e.message?.includes('401') || e.message?.includes('Invalid')
        ? 'Invalid username or password.'
        : (e.message || 'Login failed.');
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">
      <img src="/icons/icon-128.png" alt="CrispLens" class="login-icon" />
      <div class="login-brand">
        <span class="login-name">CrispLens</span>
        <span class="login-sub">AI-Powered Image &amp; Face Recognition</span>
      </div>
    </div>

    <form class="login-form" on:submit|preventDefault={doLogin}>
      <div class="field">
        <label for="un">Username</label>
        <input
          id="un"
          type="text"
          bind:value={username}
          autocomplete="username"
          spellcheck="false"
          placeholder="admin"
          disabled={loading}
        />
      </div>
      <div class="field">
        <label for="pw">Password</label>
        <input
          id="pw"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          placeholder="••••••••"
          disabled={loading}
        />
      </div>

      {#if error}
        <div class="login-error">{error}</div>
      {/if}

      <button type="submit" class="primary login-btn" disabled={loading || !username || !password}>
        {#if loading}Signing in…{:else}Sign in{/if}
      </button>
    </form>
  </div>
</div>

<style>
  .login-wrap {
    position: fixed;
    inset: 0;
    background: #0e0e1a;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .login-card {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 16px;
    padding: 36px 40px 32px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 8px 48px rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  /* Logo row */
  .login-logo {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .login-icon {
    width: 52px;
    height: 52px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  .login-brand {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .login-name {
    font-size: 20px;
    font-weight: 700;
    color: #e0e8ff;
    letter-spacing: 0.2px;
  }

  .login-sub {
    font-size: 11px;
    color: #5060a0;
    line-height: 1.4;
  }

  /* Form */
  .login-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field label {
    font-size: 11px;
    color: #6070a0;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .field input {
    font-size: 14px;
    padding: 9px 12px;
    border-radius: 7px;
    background: #0e0e1a;
    border: 1px solid #2a2a4a;
    color: #e0e0f0;
    transition: border-color 0.15s;
  }

  .field input:focus {
    border-color: #4a6fa5;
    outline: none;
  }

  .field input:disabled {
    opacity: 0.5;
  }

  .login-error {
    background: #2a1a1a;
    border: 1px solid #5a2a2a;
    border-radius: 6px;
    padding: 9px 12px;
    font-size: 12px;
    color: #d08080;
  }

  .login-btn {
    width: 100%;
    padding: 10px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 8px;
    margin-top: 4px;
    transition: background 0.15s, opacity 0.15s;
  }

  .login-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
