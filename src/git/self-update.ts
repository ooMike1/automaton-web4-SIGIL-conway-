/**
 * Git Self-Update
 *
 * Attempts to pull the latest code from the remote git repository
 * at the start of each agent turn. This allows the automaton to
 * evolve by receiving code updates pushed to its repo.
 *
 * Safety:
 * - Only pulls if a remote "origin" exists
 * - Uses git pull --ff-only to avoid merge conflicts
 * - If pull fails (conflicts, network), logs warning and continues
 * - Cooldown prevents pulling more than once per 60 seconds
 * - Tracks last update result in KV store
 */

import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { fileURLToPath } from "url";
import path from "path";
import { execSync } from "child_process";

const UPDATE_COOLDOWN_MS = 60_000; // min 60s between pull attempts
const GIT_TIMEOUT_MS = 30_000;

/**
 * Resolve the project root directory (where the automaton source lives).
 */
function getProjectRoot(): string {
  // When running as compiled JS, __dirname equivalent via import.meta.url
  // Walk up from src/git/ to project root
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(thisFile), "..", "..");
  } catch {
    // Fallback: use process.cwd()
    return process.cwd();
  }
}

/**
 * Check if a git remote "origin" exists in the given repo.
 */
function hasRemote(repoPath: string): boolean {
  try {
    const result = execSync("git remote get-url origin 2>/dev/null", {
      cwd: repoPath,
      timeout: 5000,
      encoding: "utf-8",
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

export interface SelfUpdateResult {
  updated: boolean;
  message: string;
  newCommits: number;
  error?: string;
}

/**
 * Attempt to self-update the automaton's source code from git.
 *
 * Called at the start of each agent turn. Respects a cooldown to
 * avoid excessive network calls.
 *
 * @param db - Database for KV storage (cooldown tracking)
 * @param conway - Conway client (optional, for sandbox exec)
 * @returns Result of the update attempt
 */
export async function attemptSelfUpdate(
  db?: AutomatonDatabase,
  conway?: ConwayClient,
): Promise<SelfUpdateResult> {
  const projectRoot = getProjectRoot();

  // Check cooldown
  if (db) {
    const lastAttempt = db.getKV("git_self_update_last_attempt");
    if (lastAttempt) {
      const elapsed = Date.now() - new Date(lastAttempt).getTime();
      if (elapsed < UPDATE_COOLDOWN_MS) {
        return {
          updated: false,
          message: `Cooldown active (${Math.ceil((UPDATE_COOLDOWN_MS - elapsed) / 1000)}s remaining)`,
          newCommits: 0,
        };
      }
    }
  }

  // Record attempt time
  if (db) {
    db.setKV("git_self_update_last_attempt", new Date().toISOString());
  }

  // Check if remote exists
  if (!hasRemote(projectRoot)) {
    return {
      updated: false,
      message: "No git remote 'origin' configured. Skipping self-update.",
      newCommits: 0,
    };
  }

  try {
    // Get current HEAD before pull
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    // Get current branch
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectRoot,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    // Fetch latest from origin
    execSync(`git fetch origin ${branch} 2>&1`, {
      cwd: projectRoot,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf-8",
    });

    // Check if there are new commits
    let newCommitCount = 0;
    try {
      const countOutput = execSync(
        `git rev-list HEAD..origin/${branch} --count 2>/dev/null`,
        {
          cwd: projectRoot,
          timeout: 5000,
          encoding: "utf-8",
        },
      );
      newCommitCount = parseInt(countOutput.trim()) || 0;
    } catch {
      // Branch may not have upstream tracking
      newCommitCount = 0;
    }

    if (newCommitCount === 0) {
      if (db) {
        db.setKV("git_self_update_last_result", "up-to-date");
      }
      return {
        updated: false,
        message: `Already up to date on branch '${branch}'.`,
        newCommits: 0,
      };
    }

    // Stash any local changes before pulling
    const statusOutput = execSync("git status --porcelain", {
      cwd: projectRoot,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    const hasLocalChanges = statusOutput.length > 0;
    if (hasLocalChanges) {
      execSync("git stash push -m 'automaton-self-update-autostash'", {
        cwd: projectRoot,
        timeout: 10000,
        encoding: "utf-8",
      });
    }

    // Pull with fast-forward only (safe — no merge commits)
    try {
      execSync(`git pull --ff-only origin ${branch} 2>&1`, {
        cwd: projectRoot,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf-8",
      });
    } catch (pullErr: any) {
      // If ff-only fails, try rebase
      try {
        execSync(`git pull --rebase origin ${branch} 2>&1`, {
          cwd: projectRoot,
          timeout: GIT_TIMEOUT_MS,
          encoding: "utf-8",
        });
      } catch (rebaseErr: any) {
        // Abort rebase if it fails
        try {
          execSync("git rebase --abort 2>/dev/null", {
            cwd: projectRoot,
            timeout: 5000,
          });
        } catch { /* ignore */ }

        // Restore stashed changes
        if (hasLocalChanges) {
          try {
            execSync("git stash pop 2>/dev/null", {
              cwd: projectRoot,
              timeout: 5000,
            });
          } catch { /* ignore */ }
        }

        if (db) {
          db.setKV("git_self_update_last_result", `error: ${rebaseErr.message}`);
        }
        return {
          updated: false,
          message: `Pull failed (conflicts). Continuing with current code.`,
          newCommits: 0,
          error: rebaseErr.message,
        };
      }
    }

    // Restore stashed changes
    if (hasLocalChanges) {
      try {
        execSync("git stash pop 2>/dev/null", {
          cwd: projectRoot,
          timeout: 5000,
        });
      } catch {
        // Stash pop conflict — leave in stash, log it
        console.warn("[SELF-UPDATE] Warning: stash pop had conflicts. Local changes saved in git stash.");
      }
    }

    // Get HEAD after pull
    const headAfter = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    const wasUpdated = headBefore !== headAfter;

    if (db) {
      db.setKV("git_self_update_last_result", wasUpdated ? `updated: ${newCommitCount} commits` : "up-to-date");
      db.setKV("git_self_update_last_head", headAfter);
    }

    return {
      updated: wasUpdated,
      message: wasUpdated
        ? `Updated! Pulled ${newCommitCount} new commit(s) on '${branch}'. HEAD: ${headAfter.slice(0, 8)}`
        : `Already up to date on branch '${branch}'.`,
      newCommits: wasUpdated ? newCommitCount : 0,
    };
  } catch (err: any) {
    if (db) {
      db.setKV("git_self_update_last_result", `error: ${err.message}`);
    }
    return {
      updated: false,
      message: `Self-update failed: ${err.message}`,
      newCommits: 0,
      error: err.message,
    };
  }
}
