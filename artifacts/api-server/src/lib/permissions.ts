import { workspaceRoles, type WorkspaceRole } from "@workspace/db";

/*
 * Roles and what each can do. Routes ask "can this role do X?" through requireAccess() (lib/access.ts) and never
 * compare role names themselves, so changing what a role may do is a change to this table only.
 */

export type Permission =
  | "posts:read" | "posts:write" | "posts:publish" | "posts:delete"
  | "media:write"
  | "accounts:read" | "accounts:manage"
  | "queues:manage" | "organize:manage"
  | "analytics:read" | "analytics:refresh"
  | "team:read" | "team:manage"
  | "approvals:read" | "approvals:request" | "approvals:decide" | "approvals:manage"
  | "inbox:read" | "inbox:reply" | "inbox:manage"
  | "ai:read" | "ai:use" | "ai:manage"
  | "library:read" | "library:write"
  | "reports:read" | "reports:manage";

export const ALL_PERMISSIONS: Permission[] = [
  "posts:read", "posts:write", "posts:publish", "posts:delete", "media:write", "accounts:read", "accounts:manage",
  "queues:manage", "organize:manage", "analytics:read", "analytics:refresh", "team:read", "team:manage",
  "approvals:read", "approvals:request", "approvals:decide", "approvals:manage", "inbox:read", "inbox:reply", "inbox:manage",
  "ai:read", "ai:use", "ai:manage", "library:read", "library:write",
  "reports:read", "reports:manage",
];

const READ: Permission[] = ["posts:read", "accounts:read", "analytics:read", "team:read", "approvals:read", "inbox:read", "ai:read", "library:read", "reports:read"];
const EDIT: Permission[] = [...READ, "posts:write", "posts:publish", "posts:delete", "media:write", "queues:manage", "organize:manage", "analytics:refresh",
  "approvals:request", "inbox:reply", "inbox:manage", "ai:use", "library:write", "reports:manage"];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  editor: EDIT,
  // An approver reads everything and decides on approval requests; they don't edit posts.
  approver: [...READ, "approvals:decide"],
  viewer: READ,
};

export const ROLE_INFO: Record<WorkspaceRole, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Everything, including managing the team. Every workspace has one owner." },
  admin: { label: "Admin", description: "Everything except owning the workspace: connect accounts, manage the team, publish." },
  editor: { label: "Editor", description: "Create, edit, schedule and publish posts; manage queues, tags and media. Can't connect accounts or manage people." },
  approver: { label: "Approver", description: "Can see posts, accounts and analytics, and approve or reject posts sent for approval." },
  viewer: { label: "Viewer", description: "Read-only: posts, calendar, accounts and analytics." },
};

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (workspaceRoles as readonly string[]).includes(value);
}

const RANK: Record<WorkspaceRole, number> = { owner: 4, admin: 3, editor: 2, approver: 1, viewer: 1 };

/** Roles this role may hand out: only people who manage the team can, owners anything below owner, admins anything below admin. */
export function grantableRoles(role: WorkspaceRole): WorkspaceRole[] {
  if (!can(role, "team:manage")) return [];
  return workspaceRoles.filter((candidate) => candidate !== "owner" && RANK[candidate] < RANK[role] || (role === "owner" && candidate === "admin"));
}

/** Whether `actor` may change or remove someone who currently holds `target`. Nobody manages their equal or superior, and owners are never managed. */
export function canManage(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  return target !== "owner" && RANK[actor] > RANK[target];
}
