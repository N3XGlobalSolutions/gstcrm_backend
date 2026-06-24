import { db } from "@/db";
import { items, entries } from "@/db/schema";
import { and, eq, ilike, count, sql, desc } from "drizzle-orm";
import type { z } from "zod";
import type { ListItemsSchema } from "./schema";

type ListInput = z.infer<typeof ListItemsSchema>;

// ─── findMany ────────────────────────────────────────────────────────────────

export async function findManyItems(input: ListInput) {
  const offset = (input.page - 1) * input.limit;

  const conditions = [eq(items.is_deleted, false)];
  if (input.type) conditions.push(eq(items.type, input.type));
  if (input.search) conditions.push(ilike(items.name, `%${input.search}%`));

  const where = and(...conditions);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(items)
      .where(where)
      .orderBy(desc(items.entry_no))
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(items).where(where),
  ]);

  return { data, total: countRow?.total ?? 0 };
}

// ─── findById ────────────────────────────────────────────────────────────────

export async function findItemById(id: string) {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.is_deleted, false)))
    .limit(1);
  return item ?? null;
}

// ─── findByNameAndType ───────────────────────────────────────────────────────

export async function findItemByNameAndType(
  name: string,
  type: string,
  excludeId?: string,
) {
  const conditions = [
    ilike(items.name, name),
    eq(items.type, type as any),
    eq(items.is_deleted, false),
  ];
  if (excludeId) conditions.push(sql`${items.id} != ${excludeId}`);

  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(...conditions))
    .limit(1);
  return item ?? null;
}

// ─── isItemInUse ─────────────────────────────────────────────────────────────

export async function isItemInUse(id: string) {
  const [row] = await db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.item_id, id))
    .limit(1);
  return !!row;
}

// ─── insertItem ──────────────────────────────────────────────────────────────

export async function insertItem(values: {
  entry_no: number;
  name: string;
  type: "GOLD" | "ORNAMENT" | "MONEY";
  unit: "GRAM" | "PIECE" | "RUPEE";
}) {
  const [item] = await db.insert(items).values(values).returning();
  return item!;
}

// ─── updateItem ──────────────────────────────────────────────────────────────

export async function updateItemName(id: string, name: string) {
  const [item] = await db
    .update(items)
    .set({ name, updated_at: new Date() })
    .where(eq(items.id, id))
    .returning();
  return item!;
}

// ─── softDeleteItem ──────────────────────────────────────────────────────────

export async function softDeleteItem(id: string) {
  await db
    .update(items)
    .set({ is_deleted: true, updated_at: new Date() })
    .where(eq(items.id, id));
}
