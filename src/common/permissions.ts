/**
 * Canonical list of application modules (matches frontend src/data/staff.ts).
 * Used as the keys in Role.permissions[].
 *
 * IMPORTANT: the string values include an en-dash (–) in "CRM – Sellers" and
 * "CRM – Buyers", matching the frontend prototype. Don't use a hyphen (-).
 */
export enum AppModule {
  DASHBOARD = 'Dashboard',
  INVENTORY = 'Inventory',
  CRM_SELLERS = 'CRM – Sellers',
  CRM_BUYERS = 'CRM – Buyers',
  LEADS = 'Leads & Sales',
  ACCOUNTING = 'Accounting',
  BHPH = 'BHPH',
  MARKETING = 'Digital Marketing',
  DEALER_WEBSITE = 'Dealer Website',
  MARKETPLACE = 'Dealer Marketplace',
  CALENDAR = 'Calendar',
  COMMUNICATION = 'Communication',
  SUPPORT = 'Support',
  STAFF = 'Staff',
  ROLES = 'Roles',
  SETTINGS = 'Settings',
}

export enum PermissionAction {
  VIEW = 'view',
  EDIT = 'edit',
  DELETE = 'delete',
}

export type RolePermission = {
  module: AppModule;
  actions: PermissionAction[];
};

export const ALL_MODULES = Object.values(AppModule);
const ALL_ACTIONS: PermissionAction[] = [
  PermissionAction.VIEW,
  PermissionAction.EDIT,
  PermissionAction.DELETE,
];

/**
 * Default seed roles. Mirrors src/data/staff.ts roles in the frontend prototype.
 *
 * Seeded on first boot if the roles collection is empty (or any of these names is missing).
 * Marked `isSystem: true` so they cannot be deleted via the API.
 */
export const DEFAULT_ROLES: {
  name: string;
  description: string;
  permissions: RolePermission[];
}[] = [
  {
    name: 'Admin',
    description: 'Full system access',
    permissions: ALL_MODULES.map((module) => ({ module, actions: [...ALL_ACTIONS] })),
  },
  {
    name: 'Sales Manager',
    description: 'Manages sales pipeline and staff',
    permissions: [
      { module: AppModule.DASHBOARD, actions: [PermissionAction.VIEW] },
      { module: AppModule.INVENTORY, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.CRM_SELLERS, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.CRM_BUYERS, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.LEADS, actions: [PermissionAction.VIEW, PermissionAction.EDIT, PermissionAction.DELETE] },
      { module: AppModule.CALENDAR, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.COMMUNICATION, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.STAFF, actions: [PermissionAction.VIEW] },
    ],
  },
  {
    name: 'Sales Staff',
    description: 'Handles assigned leads and bookings',
    permissions: [
      { module: AppModule.DASHBOARD, actions: [PermissionAction.VIEW] },
      { module: AppModule.INVENTORY, actions: [PermissionAction.VIEW] },
      { module: AppModule.CRM_BUYERS, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.LEADS, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.CALENDAR, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.COMMUNICATION, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
    ],
  },
  {
    name: 'Marketing',
    description: 'Manages campaigns and website content',
    permissions: [
      { module: AppModule.DASHBOARD, actions: [PermissionAction.VIEW] },
      { module: AppModule.MARKETING, actions: [PermissionAction.VIEW, PermissionAction.EDIT, PermissionAction.DELETE] },
      { module: AppModule.DEALER_WEBSITE, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.MARKETPLACE, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
    ],
  },
  {
    name: 'Support',
    description: 'Customer support and ticket handling',
    permissions: [
      { module: AppModule.DASHBOARD, actions: [PermissionAction.VIEW] },
      { module: AppModule.SUPPORT, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
      { module: AppModule.COMMUNICATION, actions: [PermissionAction.VIEW, PermissionAction.EDIT] },
    ],
  },
];

/**
 * Legacy `UserRole` string → seeded role name. Used by the migration on boot
 * to convert pre-refactor users (where `user.role` was a string enum) into the
 * new `roleId` ObjectId reference.
 */
export const LEGACY_ROLE_MAP: Record<string, string> = {
  admin: 'Admin',
  manager: 'Sales Manager',
  sales_agent: 'Sales Staff',
  support: 'Support',
};
