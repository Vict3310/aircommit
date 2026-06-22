import { getSupabase } from '../services/supabase.js';
import { requireSession, fetchFile, getDefaultBranch, getRepoFilePaths } from '../services/github.js';
import config from '../core/config.js';
import { fetchWithTimeout } from '../core/fetch-timeout.js';

async function generateEmbedding(text) {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key is required to generate embeddings for RAG.');
  }
  const response = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    })
  }, 15000);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('OpenAI returned an invalid response.');
  }
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
}

/**
 * Generates embeddings in batches (OpenAI supports up to 100 per request)
 */
async function generateEmbeddingsBatch(texts) {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key is required to generate embeddings for RAG.');
  }
  if (texts.length === 0) return [];

  const response = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts
    })
  }, 15000);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('OpenAI returned an invalid response.');
  }
  if (data.error) throw new Error(data.error.message);
  return data.data.map(result => result.embedding);
}

function chunkText(text, maxChars = 1500) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxChars));
    i += maxChars;
  }
  return chunks;
}

export function registerRagCommands(bot, sendStatus) {
  bot.onText(/^\/index$/, async (msg) => {
    const chatId = msg.chat.id;
    const status = await sendStatus(chatId, '🔍 Scanning repository for indexing...');

    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error('Supabase is not configured. RAG requires Supabase pgvector.');
      if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is missing in your .env. It is required for embeddings.');

      const { octokit, owner, repo } = await requireSession(chatId);
      const defaultBranch = await getDefaultBranch(octokit, owner, repo);
      const filePaths = await getRepoFilePaths(octokit, owner, repo, defaultBranch);

      await status.update(`📂 Found ${filePaths.length} files. Removing old index for ${owner}/${repo}...`);
      await supabase.from('repo_embeddings')
        .delete()
        .eq('owner', owner)
        .eq('repo', repo);

      await status.update(`⏳ Generating embeddings for ${filePaths.length} files. This may take a while...`);

      let indexedCount = 0;
      const BATCH_SIZE = 100; // OpenAI batch size limit

      for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
        const batchFiles = filePaths.slice(i, i + BATCH_SIZE);

        // Prepare all texts for batch embedding
        const batchEmbeddingPromises = batchFiles.map(async (filePath) => {
          try {
            const { content } = await fetchFile(octokit, owner, repo, filePath);
            const chunks = chunkText(content);

            // Batch generate embeddings for all chunks in this file
            const chunkTexts = chunks.map(c => `File: ${filePath}\n\n${c}`);
            const embeddings = await generateEmbeddingsBatch(chunkTexts);

            return chunks.map((chunk, chunkIndex) => ({
              filePath,
              chunk,
              chunkIndex,
              embedding: embeddings[chunkIndex]
            }));
          } catch (err) {
            console.warn(`Skipping ${filePath}: ${err.message}`);
            return [];
          }
        });

        // Process all batch files
        const batchResults = await Promise.all(batchEmbeddingPromises);
        const allChunks = batchResults.flat();

        // Bulk insert to Supabase
        await supabase.from('repo_embeddings').insert(
          allChunks.map(c => ({
            owner, repo, file_path: c.filePath,
            chunk_index: c.chunkIndex, content: c.chunk, embedding: c.embedding
          }))
        );

        indexedCount += batchFiles.length;
        await status.update(`⏳ Indexed ${indexedCount} / ${filePaths.length} files...`);
      }

      await status.update(`✅ *Indexing Complete!*\nSuccessfully vectorized ${indexedCount} files in \`${owner}/${repo}\`!`);
    } catch (e) {
      await status.update(`❌ Indexing failed: ${e.message}`);
    }
  });

  bot.onText(/^\/search\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];

    const status = await sendStatus(chatId, '🔍 Searching codebase...');
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error('Supabase is not configured.');

      const { owner, repo } = await requireSession(chatId);
      const embedding = await generateEmbedding(query);

      const { data: matches, error } = await supabase.rpc('match_repo_embeddings', {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: 3,
        search_owner: owner,
        search_repo: repo
      });

      if (error) throw error;

      if (!matches || matches.length === 0) {
        await status.update(`❌ No highly relevant code found for your query.`);
        return;
      }

      const results = matches.map((m, i) => `*${i + 1}. \`${m.file_path}\`* (Match: ${(m.similarity * 100).toFixed(1)}%)\n\`\`\`\n${m.content.substring(0, 500)}...\n\`\`\``).join('\n\n');

      await status.delete();
      bot.sendMessage(chatId, `🔍 *Semantic Search Results:*\n\n${results}`, { parse_mode: 'Markdown' });

    } catch (error) {
      await status.update(`❌ Search failed: ${error.message}`);
    }
  });
}
