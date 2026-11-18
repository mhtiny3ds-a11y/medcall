// Kho dữ liệu JSON đơn giản (không cần cài database). Ghi file nguyên tử để tránh hỏng dữ liệu.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DB_FILE = process.env.DB_FILE || path.resolve("data/db.json");

const empty = () => ({ patients: [], medications: [], doses: [], calls: [] });

let state = load();

function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {
    return empty();
  }
}

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomUUID().slice(0, 8);

export const db = {
  all: (table) => state[table],
  get: (table, id) => state[table].find((r) => r.id === id),
  find: (table, pred) => state[table].filter(pred),
  insert(table, row) {
    const rec = { id: newId(), createdAt: new Date().toISOString(), ...row };
    state[table].push(rec);
    save();
    return rec;
  },
  update(table, id, patch) {
    const rec = state[table].find((r) => r.id === id);
    if (!rec) return null;
    Object.assign(rec, typeof patch === "function" ? patch(rec) : patch);
    save();
    return rec;
  },
  remove(table, id) {
    const before = state[table].length;
    state[table] = state[table].filter((r) => r.id !== id);
    save();
    return state[table].length !== before;
  },
  reset() {
    state = empty();
    save();
  },
};
