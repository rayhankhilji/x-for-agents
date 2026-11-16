import fs from "node:fs";
import path from "node:path";
import { collectionsDir, config, indexFile } from "./config.js";
import type { Post } from "./parse.js";

/** Append-only JSONL index of every post ever collected, keyed by id (last write wins). */
export class PostStore {
  private posts = new Map<string, Post>();
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
    fs.mkdirSync(config.dataDir, { recursive: true });
    const lines: string[] = [];
    for (const p of posts) {
      this.posts.set(p.id, p);
      lines.push(JSON.stringify(p));
    }
    if (lines.length) fs.appendFileSync(indexFile(), lines.join("\n") + "\n");
  }

  /** Save one collection run as a standalone JSON file and return its path. */
  saveCollection(label: string, data: unknown): string {
    fs.mkdirSync(collectionsDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 60);
    const file = path.join(collectionsDir(), `${stamp}_${safe}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }
}
