import { db } from "@/db";
import { userFormPermissions, userActivityPermissions } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Check whether a user has access to a specific form and action.
 *
 * Two-layer model (per BACKEND_PLAN §9.1):
 *  Layer 1 — Form access: user_form_permissions.allowed must be true
 *  Layer 2 — Activity rights: user_activity_permissions.[can_view|can_edit|can_delete]
 *
 * Both checks must pass for the procedure to continue.
 *
 * Per-request only — NOT globally cached to prevent stale data.
 *
 * @param userId  - app_users.id (UUID)
 * @param module  - Module name string, e.g. "purchase"
 * @param form    - Form/screen name, e.g. "purchase"
 * @param action  - One of "view" | "edit" | "delete"
 */
export async function checkPermission(
  userId: string,
  module: string,
  form: string,
  action: "view" | "edit" | "delete",
): Promise<boolean> {
  const [formRow, activityRow] = await Promise.all([
    // Layer 1: form access
    db
      .select({ allowed: userFormPermissions.allowed })
      .from(userFormPermissions)
      .where(
        and(
          eq(userFormPermissions.user_id, userId),
          eq(userFormPermissions.module, module),
          eq(userFormPermissions.form_name, form),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),

    // Layer 2: activity rights
    db
      .select({
        can_view: userActivityPermissions.can_view,
        can_edit: userActivityPermissions.can_edit,
        can_delete: userActivityPermissions.can_delete,
      })
      .from(userActivityPermissions)
      .where(eq(userActivityPermissions.user_id, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  // Layer 1 — form permission must explicitly exist and be allowed
  if (!formRow || !formRow.allowed) return false;

  // Layer 2 — activity permission must exist and the specific right must be true
  if (!activityRow) return false;

  if (action === "view") return activityRow.can_view;
  if (action === "edit") return activityRow.can_edit;
  if (action === "delete") return activityRow.can_delete;

  return false;
}
