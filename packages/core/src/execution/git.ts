import { simpleGit, type SimpleGit, type StatusResult, type LogResult } from "simple-git";

/**
 * Git execution layer using simple-git.
 *
 * Provides programmatic git operations with richer output
 * than raw shell commands. Used by the executor when an
 * intent is a git.* intent.
 */

function getGit(path = "."): SimpleGit {
  return simpleGit(path);
}

export async function gitStatus(path = "."): Promise<string> {
  const git = getGit(path);
  const status: StatusResult = await git.status();

  const lines: string[] = [];
  lines.push(`Branch: ${status.current ?? "detached"}`);

  if (status.tracking) {
    lines.push(`Tracking: ${status.tracking}`);
    if (status.ahead > 0) lines.push(`  Ahead: ${status.ahead} commit(s)`);
    if (status.behind > 0) lines.push(`  Behind: ${status.behind} commit(s)`);
  }

  if (status.staged.length > 0) {
    lines.push(`\nStaged (${status.staged.length}):`);
    for (const f of status.staged) lines.push(`  + ${f}`);
  }

  if (status.modified.length > 0) {
    lines.push(`\nModified (${status.modified.length}):`);
    for (const f of status.modified) lines.push(`  ~ ${f}`);
  }

  if (status.not_added.length > 0) {
    lines.push(`\nUntracked (${status.not_added.length}):`);
    for (const f of status.not_added) lines.push(`  ? ${f}`);
  }

  if (status.deleted.length > 0) {
    lines.push(`\nDeleted (${status.deleted.length}):`);
    for (const f of status.deleted) lines.push(`  - ${f}`);
  }

  if (status.conflicted.length > 0) {
    lines.push(`\nConflicted (${status.conflicted.length}):`);
    for (const f of status.conflicted) lines.push(`  ! ${f}`);
  }

  if (
    status.staged.length === 0 &&
    status.modified.length === 0 &&
    status.not_added.length === 0 &&
    status.deleted.length === 0
  ) {
    lines.push("\nWorking tree clean.");
  }

  return lines.join("\n");
}

export async function gitLog(path = ".", count = 10): Promise<string> {
  const git = getGit(path);
  const log: LogResult = await git.log({ maxCount: count });

  const lines: string[] = [];
  for (const entry of log.all) {
    const date = entry.date.split("T")[0] ?? entry.date;
    const hash = entry.hash.slice(0, 7);
    lines.push(`${hash} ${date} ${entry.message} (${entry.author_name})`);
  }

  return lines.join("\n") || "No commits found.";
}

export async function gitDiff(path = ".", target?: string): Promise<string> {
  const git = getGit(path);
  const args = target ? [target] : [];
  const diff = await git.diff(args);
  return diff || "No differences.";
}

export async function gitPull(path = ".", remote = "origin", branch?: string): Promise<string> {
  const git = getGit(path);
  const result = await git.pull(remote, branch);

  const lines: string[] = [];
  if (result.summary.changes) lines.push(`Changes: ${result.summary.changes}`);
  if (result.summary.insertions) lines.push(`Insertions: ${result.summary.insertions}`);
  if (result.summary.deletions) lines.push(`Deletions: ${result.summary.deletions}`);

  if (result.files.length > 0) {
    lines.push(`\nFiles updated (${result.files.length}):`);
    for (const f of result.files) lines.push(`  ${f}`);
  }

  return lines.join("\n") || "Already up to date.";
}

export async function gitPush(path = ".", remote = "origin", branch?: string): Promise<string> {
  const git = getGit(path);
  const result = await git.push(remote, branch);

  const lines: string[] = [];
  if (result.pushed.length > 0) {
    for (const p of result.pushed) {
      lines.push(`Pushed: ${p.local} → ${p.remote}`);
    }
  }

  return lines.join("\n") || "Push complete.";
}

export async function gitBranch(path = "."): Promise<string> {
  const git = getGit(path);
  const branches = await git.branch();

  const lines: string[] = [];
  lines.push(`Current: ${branches.current}`);
  lines.push(`\nAll branches:`);
  for (const name of branches.all) {
    const prefix = name === branches.current ? "* " : "  ";
    lines.push(`${prefix}${name}`);
  }

  return lines.join("\n");
}

export async function gitCheckout(branch: string, path = "."): Promise<string> {
  const git = getGit(path);
  await git.checkout(branch);
  return `Switched to branch: ${branch}`;
}

export async function gitCommit(message: string, path = "."): Promise<string> {
  const git = getGit(path);
  const result = await git.commit(message);
  return `Committed: ${result.commit} — ${message}\n${result.summary.changes} file(s) changed, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
}

export async function gitAdd(target = ".", path = "."): Promise<string> {
  const git = getGit(path);
  await git.add(target);
  return `Staged: ${target}`;
}

export async function gitStash(action = "push", path = "."): Promise<string> {
  const git = getGit(path);
  if (action === "pop" || action === "restore") {
    const result = await git.stash(["pop"]);
    return result || "Stash popped.";
  }
  if (action === "list") {
    const result = await git.stash(["list"]);
    return result || "No stashes.";
  }
  const result = await git.stash(["push"]);
  return result || "Changes stashed.";
}

export async function gitReset(target = "HEAD", path = "."): Promise<string> {
  const git = getGit(path);
  await git.reset([target]);
  return `Reset to: ${target}`;
}
