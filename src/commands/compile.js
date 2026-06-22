import solc from 'solc';
import path from 'path';
import { requireSession, fetchFile } from '../services/github.js';
import { getSupabase } from '../services/supabase.js';
import { getUserSession } from '../services/supabase.js';
import { uploadAuditLogTo0G } from '../services/zerog.js';
import { ZgFile } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import config from '../core/config.js';
import { hasFeature, premiumFeatureMessage } from '../services/subscription.js';

// We need a custom upload for compile artifacts since it's a specific payload
async function uploadCompileArtifactTo0G(chatId, repo, contractName, compileData) {
  if (!config.zerogPrivateKey) return null;

  // Setup ethers signer and indexer
  const provider = new ethers.JsonRpcProvider(config.zerogEvmRpc);
  const signer = new ethers.Wallet(config.zerogPrivateKey, provider);
  const indexer = new (await import('@0gfoundation/0g-storage-ts-sdk')).Indexer(config.zerogIndexerRpc);

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-compile-${contractName}-${Date.now()}.json`);

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(compileData, null, 2), 'utf-8');

    const zgFile = await ZgFile.fromFilePath(tmpFile);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr !== null) throw new Error(`Failed to compute Merkle tree: ${treeErr}`);

    const rootHash = tree.rootHash();

    const [txHash, uploadErr] = await indexer.upload(zgFile, config.zerogEvmRpc, signer);
    if (uploadErr !== null) throw new Error(`0G upload failed: ${uploadErr}`);

    // Persist to Supabase if config allows
    const supabase = getSupabase();
    if (supabase) {
      await supabase.from('audit_logs').insert({
        chat_id: chatId.toString(),
        repo,
        action_type: 'COMPILE_SOLIDITY',
        file_path: contractName,
        commit_message: `Solidity compilation for ${contractName}`,
        root_hash: rootHash,
        tx_hash: txHash,
      });
    }

    return { txHash, rootHash };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { }
  }
}

export function registerCompileCommands(bot, sendStatus) {

  bot.onText(/^\/compile\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const filepath = match[1];

    // Check subscription
    const session = await getUserSession(chatId);
    if (!hasFeature(session, 'compile')) {
      return bot.sendMessage(chatId, premiumFeatureMessage());
    }

    const status = await sendStatus(chatId, `🔍 Fetching Solidity contract \`${filepath}\`...`);

    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      const { content } = await fetchFile(octokit, owner, repo, filepath);

      if (!content) {
        throw new Error('Contract file content is empty.');
      }

      await status.update(`⚙️ Compiling Solidity contract using \`solc\`...`);

      const filename = path.basename(filepath);
      const input = {
        language: 'Solidity',
        sources: {
          [filename]: {
            content: content
          }
        },
        settings: {
          outputSelection: {
            '*': {
              '*': ['abi', 'evm.bytecode.object']
            }
          }
        }
      };

      // Compile the contract
      let compiledJson;
      try {
        compiledJson = JSON.parse(solc.compile(JSON.stringify(input)));
      } catch (parseErr) {
        throw new Error(`Solidity compiler returned invalid JSON: ${parseErr.message}`);
      }

      // Handle Errors
      if (compiledJson.errors) {
        const errors = compiledJson.errors.filter(e => e.severity === 'error');
        if (errors.length > 0) {
          const errMsg = errors.map(e => `• Line ${e.sourceLocation?.start || '?'}: ${e.message}`).join('\n');
          throw new Error(`Compilation Failed:\n\n${errMsg}`);
        }
      }

      const contracts = compiledJson.contracts[filename];
      if (!contracts || Object.keys(contracts).length === 0) {
        throw new Error('No compiled contract classes found.');
      }

      const contractNames = Object.keys(contracts);
      await status.update(`🌐 Publishing ${contractNames.length} contract build(s) to 0G storage...`);

      const results = [];
      for (const name of contractNames) {
        const contractData = contracts[name];
        const abi = contractData.abi;
        const bytecode = contractData.evm.bytecode.object;

        const payload = {
          contractName: name,
          fileName: filename,
          compiler: 'solc-0.8.20',
          abi,
          bytecode,
          timestamp: new Date().toISOString()
        };

        const result = await uploadCompileArtifactTo0G(chatId, `${owner}/${repo}`, name, payload);
        if (result) {
          results.push({ name, ...result });
        }
      }

      if (results.length === 0) {
        throw new Error('Could not upload any compilation output to 0G.');
      }

      let responseText = `✅ *Compilation & Publication Complete!*\n\n`;
      results.forEach(res => {
        responseText += `📄 *Contract:* \`${res.name}\`\n`;
        responseText += `🔐 Root Hash: \`${res.rootHash}\`\n`;
        responseText += `🔗 Tx Hash: \`${res.txHash.slice(0, 20)}...\`\n\n`;
      });
      responseText += `The compilation artifacts (ABI & Bytecode) are now immutably available on the 0G network for frontend integration.`;

      await status.update(responseText);
    } catch (e) {
      await status.update(`❌ Compilation error: ${e.message}`);
    }
  });
}
