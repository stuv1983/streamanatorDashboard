/**
 * Household lists for the hub (to-do, shopping, ...), kept in var/hub.json.
 *
 * Anyone at the screen or on the LAN can tick and add items without signing
 * in. That is the point of a family display, and the worst case is a silly
 * shopping item. So input is bounded rather than authenticated: text length,
 * list names from config, and a cap on items.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Settings } from '../config';

export interface ListItem {
    id: string;
    list: string;
    text: string;
    done: boolean;
    createdAt: number;
    doneAt: number | null;
}

interface StoreFile {
    items: ListItem[];
}

export const MAX_ITEMS = 300;
export const MAX_TEXT = 140;
/** Ticked items stay visible this long, then drop off by themselves. */
export const DONE_RETENTION_SECONDS = 24 * 3600;

export type ListAction =
    | { action: "add"; list: string; text: string }
    | { action: "toggle"; id: string }
    | { action: "delete"; id: string }
    | { action: "clear-done"; list: string };

function storePath(settings: Settings): string {
    const configured = settings.hub.store_path;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), "..", configured);
}

function read(settings: Settings): StoreFile {
    try {
        const payload = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ storePath(settings), "utf8"));
        return { items: Array.isArray(payload?.items) ? payload.items : [] };
    } catch {
        return { items: [] };
    }
}

function write(settings: Settings, store: StoreFile): void {
    const file = storePath(settings);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function pruneDone(items: ListItem[], now = Date.now() / 1000): ListItem[] {
    return items.filter(item => !item.done || item.doneAt === null || now - item.doneAt < DONE_RETENTION_SECONDS);
}

export function getLists(settings: Settings): { lists: string[]; items: ListItem[] } {
    const lists = settings.hub.lists;
    const items = pruneDone(read(settings).items).filter(item => lists.includes(item.list));
    return { lists, items };
}

export function parseListAction(body: unknown, lists: string[]): ListAction | string {
    if (!body || typeof body !== "object") return "Expected a JSON object.";
    const b = body as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id : "";
    const list = typeof b.list === "string" ? b.list : "";
    switch (b.action) {
        case "add": {
            const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
            if (!text) return "Type something to add.";
            if (!lists.includes(list)) return "Unknown list.";
            return { action: "add", list, text };
        }
        case "toggle":
        case "delete":
            if (!/^[a-f0-9-]{8,40}$/.test(id)) return "Unknown item.";
            return { action: b.action, id };
        case "clear-done":
            if (!lists.includes(list)) return "Unknown list.";
            return { action: "clear-done", list };
        default:
            return "action must be add, toggle, delete or clear-done.";
    }
}

/** Apply one action and return the new item list, or an error message. */
export function applyListAction(items: ListItem[], action: ListAction, now = Date.now() / 1000): ListItem[] | string {
    switch (action.action) {
        case "add":
            if (items.length >= MAX_ITEMS) return `Lists are full (${MAX_ITEMS} items). Clear some ticked items first.`;
            return [...items, { id: crypto.randomUUID(), list: action.list, text: action.text, done: false, createdAt: now, doneAt: null }];
        case "toggle":
            if (!items.some(item => item.id === action.id)) return "That item is gone. The list has been refreshed.";
            return items.map(item => item.id === action.id ? { ...item, done: !item.done, doneAt: item.done ? null : now } : item);
        case "delete":
            return items.filter(item => item.id !== action.id);
        case "clear-done":
            return items.filter(item => !(item.list === action.list && item.done));
    }
}

export function updateLists(settings: Settings, action: ListAction): { lists: string[]; items: ListItem[] } | string {
    const current = pruneDone(read(settings).items);
    const next = applyListAction(current, action);
    if (typeof next === "string") return next;
    write(settings, { items: next });
    return getLists(settings);
}
