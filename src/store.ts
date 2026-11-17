import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { collectionsDir, config, indexFile } from "./config.js";
import type { Post } from "./parse.js";

export interface Run {
  id: string;
  label: string;
  created_at: string;
  url?: string;
  posts: Post[];
  [k: string]: unknown;
}

/** Append-only JSONL index of every post ever collected (last write wins), plus per-run JSON files. */
export class PostStore {
  private posts = new Map<string, Post>();
  private runs = new Map<string, Run>();
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const file = indexFile();
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Post;
        this.posts.set(p.id, p);
      } catch {
        /* skip corrupt line */
      }
    }
  }

  get(id: string): Post | undefined {
    this.load();
    return this.posts.get(id);
  }

  size(): number {
    this.load();
    return this.posts.size;
  }

  add(posts: Post[]) {
    this.load();
    const lines: string[] = [];
    for (const p of posts) {
      const prev = this.posts.get(p.id);
      // Keep the unfiltered media list if we've seen it before.
      const merged = prev && prev.media.length > p.media.length ? { ...p, media: prev.media } : p;
      this.posts.set(p.id, merged);
      lines.push(JSON.stringify(merged));
    }
    if (!lines.length) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(indexFile(), lines.join("\n") + "\n");
  }

  newRunId(): string {
    return "r" + randomUUID().replace(/-/g, "").slice(0, 8);
  }

  saveRun(run: Run): string {
    this.runs.set(run.id, run);
    fs.mkdirSync(collectionsDir(), { recursive: true });
    const safe = run.label.replace(/[^\w.-]+/g, "_").slice(0, 50);
    const file = path.join(collectionsDir(), `${run.id}_${safe}.json`);
    fs.writeFileSync(file, JSON.stringify(run));
    return file;
  }

  getRun(id: string): Run | undefined {
    const cached = this.runs.get(id);
    if (cached) return cached;
    const dir = collectionsDir();
    if (!fs.existsSync(dir)) return undefined;
    const f = fs.readdirSync(dir).find((n) => n.startsWith(id + "_"));
    if (!f) return undefined;
    const run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Run;
    this.runs.set(id, run);
    return run;
  }
}
