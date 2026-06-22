/**
 * AI-Driven PR Review Loop
 * 
 * Automatic pull request review, suggest improvements,
 * and optionally auto-approve low-risk changes.
 */

import { requireSession } from './github.js';
import { callAIRaw, callAI } from './ai.js';
import { uploadAuditLogTo0G } from './zerog.js';

// ─── Review Prompts ───────────────────────────────────────────────────────────

const PR_REVIEW_PROMPT = `You are an expert code reviewer. Analyze this Pull Request for:
1. Logic bugs and edge cases
2. Security vulnerabilities
3. Performance issues
4. Code quality and readability
5. Test coverage
6. Conventional commit message

Return as JSON:
{
  "verdict": "approve" | "needs_changes" | "strict_wait",
  "summary": "Brief summary of analysis",
  "issues": [
    {
      "type": "critical" | "warning" | "info",
      "file": "path/to/file",
      "position": "line number or context",
      "message": "Issue description",
      "suggestion": "How to fix"
    }
  ],
  "auto_approve": true | false
}`;

const PR_APPROVAL_PROMPT = `Review this PR for auto-approval eligibility.
Auto-approve ONLY if:
- No breaking changes
- No new dependencies
- Small diff (<100 lines changed)
- All tests pass
- No security concerns

Return: { approve: boolean, reason: string }`;

// ─── PR Review Functions ──────────────────────────────────────────────────────

/**
 * Reviews a pull request using AI
 */
export async function reviewPR(chatId, prNumber, options = {}) {
  const { octokit, owner, repo } = await requireSession(chatId);
  
  try {
    // Get PR info
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: diff } = await octokit.pulls.get({
      owner, repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    
    // Get files
    const { data: files } = await octokit.pulls.listFiles({
      owner, repo,
      pull_number: prNumber,
      per_page: 100,
    });
    
    // Build diff summary
    let diffSummary = '';
    for (const file of files) {
      diffSummary += `File: ${file.filename}\nChanges: +${file.additions} -${file.deletions}\n\n`;
      if (file.patch) {
        diffSummary += `Patch:\n${file.patch.substring(0, 5000)}\n\n`;
      }
    }
    
    // Get PR description
    const prDescription = `
Title: ${pr.title}
Body: ${pr.body}
Branch: ${pr.head.ref} -> ${pr.base.ref}
Files changed: ${files.length}
Additions: ${pr.additions}
Deletions: ${pr.deletions}
Diff:\n${diff.substring(0, 20000)}`;
    
    // AI Review
    const review = await callAI(PR_REVIEW_PROMPT, prDescription, undefined, chatId);
    
    return {
      prNumber,
      title: pr.title,
      verdict: review.verdict,
      summary: review.summary,
      issues: review.issues || [],
      autoApprove: review.auto_approve !== false,
      raw: review,
    };
  } catch (error) {
    return {
      prNumber,
      verdict: 'error',
      error: error.message,
    };
  }
}

/**
 * Suggests improvements to a PR
 */
export async function suggestPRImprovements(chatId, prNumber) {
  const { octokit, owner, repo } = await requireSession(chatId);
  
  try {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: files } = await octokit.pulls.listFiles({
      owner, repo,
      pull_number: prNumber,
      per_page: 50,
    });
    
    // Get file contents for analysis
    const fileContents = [];
    for (const file of files.slice(0, 5)) { // Limit to first 5 files
      try {
        const { content } = await octokit.repos.getContent({
          owner, repo,
          path: file.filename,
          ref: pr.head.sha,
        });
        
        const fileContent = Array.isArray(content) 
          ? null 
          : Buffer.from(content.content, 'base64').toString('utf-8');
        
        if (fileContent) {
          fileContents.push({ path: file.filename, content: fileContent });
        }
      } catch (err) {
        // Skip files we can't read
      }
    }
    
    // Generate improvement suggestions
    const suggestionsPrompt = `Analyze this PR and suggest 3-5 specific improvements.
Focus on: better patterns, edge cases, tests, documentation.

Return as JSON:
{
  "suggestions": [
    {
      "file": "path/to/file",
      "type": "code_quality" | "security" | "performance" | "tests" | "docs",
      "description": "What to improve",
      "suggestion": "How to improve",
      "priority": "high" | "medium" | "low"
    }
  ]
}`;
    
    const fileContext = fileContents.map(f => 
      `File: ${f.path}\nContent:\n${f.content.substring(0, 3000)}...`
    ).join('\n\n');
    
    const suggestions = await callAI(suggestionsPrompt, 
      `PR Title: ${pr.title}\nPR Body: ${pr.body}\n\nFiles:\n${fileContext}`
    );
    
    return {
      prNumber,
      title: pr.title,
      suggestions: suggestions.suggestions || [],
    };
  } catch (error) {
    return { prNumber, error: error.message };
  }
}

/**
 * Attempts to auto-approve a PR based on risk assessment
 */
export async function autoApprovePR(chatId, prNumber) {
  const { octokit, owner, repo } = await requireSession(chatId);
  
  try {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    
    // Check auto-approval criteria
    const isSmall = (pr.additions + pr.deletions) < 100;
    const isNoDeps = !pr.title.includes('dependency') && !pr.title.includes('npm');
    const isNoBreaking = !pr.title.includes('BREAKING');
    
    // Get diff for deeper analysis
    const { data: diff } = await octokit.pulls.get({
      owner, repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    
    const diffSummary = diff.substring(0, 10000);
    
    // Auto-approval assessment
    const assessment = await callAI(PR_APPROVAL_PROMPT, 
      `PR: ${pr.title}\n\nChanges:\n${diffSummary}`
    );
    
    const approved = assessment.approve && isSmall && isNoDeps && isNoBreaking;
    
    if (approved) {
      // Auto-merge if enabled
      await octokit.pulls.merge({
        owner, repo,
        pull_number: prNumber,
        merge_method: 'squash',
      });
      
      await uploadAuditLogTo0G({
        type: 'pr_automatic_merge',
        repo: `${owner}/${repo}`,
        prNumber,
        commitMessage: 'Auto-merged via AI approval',
        approvedByChatId: chatId,
      });
      
      return { success: true, merged: true, reason: assessment.reason };
    }
    
    return { 
      success: true, 
      merged: false, 
      reason: assessment.reason,
      criteria: { isSmall, isNoDeps, isNoBreaking, auto: assessment.approve },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── Command Handlers ────────────────────────────────────────────────────────

export function registerPRReviewCommands(bot, sendStatus) {
  // /pr-review <number> - Review a PR
  bot.onText(/^\/pr-review\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prNumber = parseInt(match[1]);
    
    const status = await sendStatus(chatId, `🔍 Analyzing PR #${prNumber}...`);
    
    try {
      const review = await reviewPR(chatId, prNumber);
      
      let response = `🔍 *PR #${prNumber} Review*\n\n`;
      response += `📄 Title: \`${review.title}\`\n`;
      response += `📊 Verdict: \`${review.verdict.toUpperCase()}\`\n`;
      response += `📝 Summary: ${review.summary}\n`;
      
      if (review.issues && review.issues.length > 0) {
        response += `\n⚠️ *Issues Found (${review.issues.length})*\n`;
        review.issues.slice(0, 5).forEach((issue, i) => {
          response += `${i + 1}. [${issue.type}] ${issue.file}\n`;
          response += `   ${issue.message}\n`;
          if (issue.suggestion) {
            response += `   💡 ${issue.suggestion}\n`;
          }
        });
      }
      
      if (review.autoApprove) {
        response += `\n✅ *PR is eligible for auto-approval*`;
      }
      
      await status.delete();
      await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Review failed: ${error.message}`);
    }
  });
  
  // /pr-suggest <number> - Suggest improvements
  bot.onText(/^\/pr-suggest\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prNumber = parseInt(match[1]);
    
    const status = await sendStatus(chatId, `💡 Generating improvement suggestions...`);
    
    try {
      const result = await suggestPRImprovements(chatId, prNumber);
      
      if (result.error) {
        await status.update(`❌ Error: ${result.error}`);
        return;
      }
      
      let response = `💡 *Improvement Suggestions for PR #${prNumber}*\n\n`;
      
      if (result.suggestions && result.suggestions.length > 0) {
        result.suggestions.forEach((s, i) => {
          response += `${i + 1}. [${s.type.toUpperCase()}] ${s.file}\n`;
          response += `   ${s.description}\n`;
          response += `   ${s.suggestion}\n`;
          response += `   Priority: ${s.priority}\n\n`;
        });
      } else {
        response += `No significant improvements found. PR looks good!`;
      }
      
      await status.delete();
      await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Error: ${error.message}`);
    }
  });
  
  // /pr-autoapprove <number> - Auto-approve PR
  bot.onText(/^\/pr-autoapprove\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prNumber = parseInt(match[1]);
    
    const status = await sendStatus(chatId, `⚡ Assessing auto-approval eligibility...`);
    
    try {
      const result = await autoApprovePR(chatId, prNumber);
      
      let response;
      if (result.success) {
        if (result.merged) {
          response = `✅ *PR #${prNumber} Auto-Merged!*\n\n${result.reason}`;
        } else {
          response = `🔒 *PR #${prNumber} Not Auto-Approved*\n\nReason: ${result.reason}\n\nCriteria not met:`;
          if (result.criteria) {
            if (!result.criteria.isSmall) response += `\n- Too many changes (${result.criteria.isSmall ? '✓' : '✗'} <100 lines)`;
            if (!result.criteria.isNoDeps) response += `\n- Has dependencies (${result.criteria.isNoDeps ? '✓' : '✗'})`;
            if (!result.criteria.isNoBreaking) response += `\n- May be breaking (${result.criteria.isNoBreaking ? '✓' : '✗'})`;
          }
        }
      } else {
        response = `❌ Auto-approval failed: ${result.error}`;
      }
      
      await status.delete();
      await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Error: ${error.message}`);
    }
  });
  
  // /pr-list - List open PRs
  bot.onText(/^\/pr-list(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const limit = parseInt(match[1]) || 5;
    
    const status = await sendStatus(chatId, `📋 Fetching open PRs...`);
    
    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      
      const { data: prs } = await octokit.pulls.list({
        owner, repo,
        state: 'open',
        per_page: limit,
      });
      
      if (prs.length === 0) {
        await status.update(`📋 No open PRs found for ${owner}/${repo}`);
        return;
      }
      
      let response = `📋 *Open PRs for ${owner}/${repo}*\n\n`;
      prs.forEach((pr, i) => {
        response += `${i + 1}. PR #${pr.number}: ${pr.title}\n`;
        response += `   +${pr.additions} -${pr.deletions} | ${pr.user.login}\n`;
        response += `   Branch: \`${pr.head.ref} → ${pr.base.ref}\`\n`;
        response += `   [View PR](${pr.html_url})\n\n`;
      });
      
      await status.delete();
      await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Error: ${error.message}`);
    }
  });
}
