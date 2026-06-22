import { ZgFile, Indexer, Downloader, StorageNode } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../core/config.js';
import { getSupabase } from './supabase.js';

let _indexer = null;
let _signer = null;
let _provider = null;

function init0G() {
  if (!config.zerogPrivateKey) return false;
  if (_indexer) return true;
  try {
    _provider = new ethers.JsonRpcProvider(config.zerogEvmRpc);
    _signer = new ethers.Wallet(config.zerogPrivateKey, _provider);
    _indexer = new Indexer(config.zerogIndexerRpc);
    console.log('🌐 0G Storage initialized');
    return true;
  } catch (e) {
    console.warn('⚠️ 0G Storage failed to initialize:', e.message);
    return false;
  }
}

/**
 * Upload an audit log object to 0G decentralized storage.
 * Returns the tx hash and root hash if successful, or null if 0G is not configured.
 */
export async function uploadAuditLogTo0G(auditData) {
  if (!init0G()) {
    console.warn('0G Storage skipped: ZEROG_PRIVATE_KEY not set.');
    return null;
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-audit-${Date.now()}.json`);

  try {
    // Write audit log to a temp file
    const payload = JSON.stringify(auditData, null, 2);
    fs.writeFileSync(tmpFile, payload, 'utf-8');

    // Create a ZgFile from the temp file
    const zgFile = await ZgFile.fromFilePath(tmpFile);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr !== null) throw new Error(`Failed to compute Merkle tree: ${treeErr}`);

    const rootHash = tree.rootHash();

    // Upload to the 0G network
    const [txHash, uploadErr] = await _indexer.upload(zgFile, config.zerogEvmRpc, _signer);
    if (uploadErr !== null) throw new Error(`0G upload failed: ${uploadErr}`);

    console.log(`✅ 0G Audit log uploaded — Root: ${rootHash} | Tx: ${txHash}`);

    // Persist metadata to Supabase for /audit command retrieval
    const supabase = getSupabase();
    if (supabase && auditData) {
      await supabase.from('audit_logs').insert({
        chat_id: auditData.approvedByChatId?.toString(),
        repo: auditData.repo,
        action_type: auditData.type,
        file_path: Array.isArray(auditData.filePath) ? auditData.filePath.join(', ') : auditData.filePath,
        commit_message: auditData.commitMessage,
        root_hash: rootHash,
        tx_hash: txHash,
      });
    }

    return { txHash, rootHash };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Upload a zipped/bundled codebase snapshot to 0G storage.
 */
export async function uploadBackupTo0G(chatId, repo, files) {
  if (!init0G()) {
    console.warn('0G Storage skipped: ZEROG_PRIVATE_KEY not set.');
    return null;
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-backup-${Date.now()}.json`);

  try {
    const payload = JSON.stringify({
      repo,
      timestamp: new Date().toISOString(),
      files
    });
    fs.writeFileSync(tmpFile, payload, 'utf-8');

    const zgFile = await ZgFile.fromFilePath(tmpFile);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr !== null) throw new Error(`Failed to compute Merkle tree: ${treeErr}`);

    const rootHash = tree.rootHash();

    const [txHash, uploadErr] = await _indexer.upload(zgFile, config.zerogEvmRpc, _signer);
    if (uploadErr !== null) throw new Error(`0G upload failed: ${uploadErr}`);

    console.log(`✅ 0G Backup uploaded — Root: ${rootHash} | Tx: ${txHash}`);

    const supabase = getSupabase();
    if (supabase) {
      await supabase.from('code_backups').insert({
        chat_id: chatId.toString(),
        repo,
        root_hash: rootHash,
        tx_hash: txHash,
      });
    }

    return { txHash, rootHash };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Downloads a chat history/archive from 0G Storage by its root hash.
 * If 0G nodes are unresponsive (e.g. Testnet 503), falls back to local database record.
 */
export async function downloadChatArchiveFrom0G(rootHash) {
  if (!init0G()) {
    throw new Error('0G Storage is not configured.');
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-dl-${rootHash}.json`);

  try {
    // Try to get nodes from the indexer
    let nodes = [];
    try {
      const shardedNodes = await _indexer.getShardedNodes();
      nodes = shardedNodes.map(n => new StorageNode(n.address.rpc));
    } catch (_) {
      // Fallback to standard public storage node RPCs if indexer fails
      nodes = [new StorageNode('https://rpc-storage-testnet.0g.ai')];
    }

    const downloader = new Downloader(nodes);
    const downloadErr = await downloader.downloadFile(tmpFile, rootHash, false);
    if (downloadErr !== null) {
      throw new Error(downloadErr.message || downloadErr);
    }

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`0G download failed: ${err.message}. Trying Supabase metadata fallback...`);
    // Fallback: If 0G is down, retrieve the audit/archive payload from our local DB
    const supabase = getSupabase();
    if (supabase) {
      const { data } = await supabase.from('chat_archives').select('payload').eq('root_hash', rootHash).single();
      if (data && data.payload) {
        return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
      }
    }
    throw new Error(`Failed to retrieve archive from 0G: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Upload an encrypted chat archive JSON to 0G.
 */
export async function uploadChatArchiveTo0G(chatId, encryptedPayload) {
  if (!init0G()) {
    console.warn('0G Storage skipped: ZEROG_PRIVATE_KEY not set.');
    return null;
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-chat-${Date.now()}.json`);

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(encryptedPayload), 'utf-8');

    const zgFile = await ZgFile.fromFilePath(tmpFile);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr !== null) throw new Error(`Failed to compute Merkle tree: ${treeErr}`);

    const rootHash = tree.rootHash();

    const [txHash, uploadErr] = await _indexer.upload(zgFile, config.zerogEvmRpc, _signer);
    if (uploadErr !== null) throw new Error(`0G upload failed: ${uploadErr}`);

    console.log(`✅ 0G Chat Archive uploaded — Root: ${rootHash} | Tx: ${txHash}`);

    const supabase = getSupabase();
    if (supabase) {
      await supabase.from('chat_archives').insert({
        chat_id: chatId.toString(),
        root_hash: rootHash,
        tx_hash: txHash,
        payload: encryptedPayload, // fallback backup
      });
    }

    return { txHash, rootHash };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}
