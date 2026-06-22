#!/usr/bin/env node
/**
 * AirCommit Local Sync Daemon
 * ─────────────────────────────────────────────────────
 * Run this in your project directory: `node aircommit-sync.js`
 *
 * It connects to your Supabase Realtime channel and listens
 * for audit logs from the AirCommit agent. Whenever the bot
 * makes an AI-driven commit to your GitHub repo, this daemon
 * automatically runs `git pull` so your local files stay
 * in perfect sync—like a live share session.
 * ─────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import ws from 'ws';

// ─── Load Config ──────────────────────────────────────
let env = {};
const envPath = resolve('./.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && !line.startsWith('#')) env[key.trim()] = vals.join('=').trim();
  });
}

const SUPABASE_URL = env.SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY must be set in your .env file.');
  process.exit(1);
}

// ─── Detect local repo ────────────────────────────────
let localRepo = null;
try {
  const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
  // Extract "owner/repo" from any git URL format
  localRepo = remote.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '').toLowerCase();
  console.log(`📦 Local repo detected: ${localRepo}`);
} catch {
  console.error('❌ Could not detect git remote. Make sure you are inside a git repository.');
  process.exit(1);
}

// ─── Connect Supabase ─────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

console.log(`\n🔗 AirCommit Sync Daemon Started`);
console.log(`🌐 Watching for AI commits on: ${localRepo}`);
console.log(`💡 Press Ctrl+C to stop.\n`);

// ─── Listen to audit_logs ────────────────────────────
supabase
  .channel('aircommit-sync')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'audit_logs'
    },
    (payload) => {
      const log = payload.new;
      
      // Only act on commits for this repo
      if (!log.repo || log.repo.toLowerCase() !== localRepo) return;

      console.log(`\n⚡ AI Commit Detected!`);
      console.log(`   📝 Commit: "${log.commit_message}"`);
      console.log(`   📁 Files:  ${log.file_path || '(multiple)'}`);
      console.log(`   🌐 0G Tx:  ${log.tx_hash || 'N/A'}`);
      console.log(`   ⏳ Pulling latest changes...`);

      try {
        const output = execSync('git pull', { encoding: 'utf-8' });
        console.log(`   ✅ Synced!\n${output.trim()}`);
      } catch (err) {
        console.error(`   ❌ git pull failed:\n${err.message}`);
      }
    }
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log(`✅ Connected. Listening for AI commits...\n`);
    } else if (status === 'CHANNEL_ERROR') {
      console.error('❌ Realtime connection failed. Check your SUPABASE_KEY permissions.');
    }
  });
